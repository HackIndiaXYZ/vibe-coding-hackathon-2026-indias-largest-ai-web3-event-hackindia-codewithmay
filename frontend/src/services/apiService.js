/**
 * apiService.js — WebSocket-first, SSE fallback
 *
 * WebSocket: ws(s)://host/ws/chat
 *   - Persistent connection, zero HTTP overhead per message
 *   - audio_chunk events arrive the instant each sentence's TTS resolves
 *
 * SSE fallback: POST /api/chat (used if WebSocket fails)
 */

const API_BASE_URL = import.meta?.env?.VITE_API_URL || 'http://localhost:3001/api';

const WS_BASE_URL = (() => {
  try {
    const url   = new URL(API_BASE_URL);
    const proto = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${url.host}/ws/chat`;
  } catch {
    return 'ws://localhost:3001/ws/chat';
  }
})();

// ── Persistent WebSocket singleton ───────────────────────────────────────────
let _ws          = null;
let _wsListeners = new Map(); // reqId → { onChunk, onComplete, onError, onAudioChunk }
let _reqCounter  = 0;

function getWebSocket() {
  if (_ws && (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING)) return _ws;

  console.log('[WS] connecting to', WS_BASE_URL);
  _ws = new WebSocket(WS_BASE_URL);

  _ws.onopen    = () => console.log('[WS] connected');
  _ws.onclose   = () => { console.log('[WS] disconnected'); _ws = null; };
  _ws.onerror   = () => { console.warn('[WS] error'); };

  _ws.onmessage = (event) => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    const { reqId, type } = data;
    const h = _wsListeners.get(reqId);
    if (!h) return;
    if (type === 'chunk'       && h.onChunk)      h.onChunk(data.content, data.intent);
    if (type === 'audio_chunk' && h.onAudioChunk) h.onAudioChunk(data.seq, data.audio, data.sentence);
    if (type === 'complete') { h.onComplete?.(data.content, data.intent, data.audio, data.usedChunkedAudio); _wsListeners.delete(reqId); }
    if (type === 'error')    { h.onError?.(new Error(data.message)); _wsListeners.delete(reqId); }
  };

  return _ws;
}

// ── ApiService ────────────────────────────────────────────────────────────────
class ApiService {
  /**
   * sendMessage — WebSocket first, SSE fallback.
   * Callbacks: onChunk(content, intent) | onComplete(content, intent, audio, usedChunkedAudio)
   *            onError(error)           | onAudioChunk(seq, audio, sentence)
   */
  async sendMessage(message, history, persona, onChunk, onComplete, onError, onAudioChunk) {
    const payload = {
      message,
      history:      history.map(m => ({ role: m.role, content: m.content })),
      systemPrompt: persona?.systemPrompt || null,
      voiceType:    persona?.voice || 'friendly',
    };

    try {
      await this._sendViaWebSocket(payload, onChunk, onComplete, onError, onAudioChunk);
      return;
    } catch (wsErr) {
      console.warn('[WS] failed, falling back to SSE:', wsErr.message);
    }

    await this._sendViaSSE(payload, onChunk, onComplete, onError, onAudioChunk);
  }

  _sendViaWebSocket(payload, onChunk, onComplete, onError, onAudioChunk) {
    return new Promise((resolve, reject) => {
      const ws    = getWebSocket();
      const reqId = ++_reqCounter;

      _wsListeners.set(reqId, {
        onChunk,
        onAudioChunk,
        onComplete: (...args) => { onComplete?.(...args); resolve(); },
        onError:    (err)     => { onError?.(err);        reject(err); },
      });

      const send = () => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ reqId, ...payload }));
        else { _wsListeners.delete(reqId); reject(new Error('WebSocket not open')); }
      };

      if (ws.readyState === WebSocket.OPEN) {
        send();
      } else if (ws.readyState === WebSocket.CONNECTING) {
        const t = setTimeout(() => { _wsListeners.delete(reqId); reject(new Error('WS connect timeout')); }, 2000);
        ws.addEventListener('open',  () => { clearTimeout(t); send(); }, { once: true });
        ws.addEventListener('error', () => { clearTimeout(t); _wsListeners.delete(reqId); reject(new Error('WS error')); }, { once: true });
      } else {
        _wsListeners.delete(reqId);
        reject(new Error('WebSocket closed'));
      }
    });
  }

  async _sendViaSSE(payload, onChunk, onComplete, onError, onAudioChunk) {
    try {
      const response = await fetch(`${API_BASE_URL}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const reader  = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === 'chunk'       && onChunk)      onChunk(data.content, data.intent);
            if (data.type === 'audio_chunk' && onAudioChunk) onAudioChunk(data.seq, data.audio, data.sentence);
            if (data.type === 'complete'    && onComplete)   onComplete(data.content, data.intent, data.audio, data.usedChunkedAudio);
            if (data.type === 'error'       && onError)      onError(new Error(data.message));
          } catch (_) {}
        }
      }
    } catch (error) {
      console.error('[SSE] error:', error);
      onError?.(error);
    }
  }

  async checkHealth() {
    try { return await (await fetch(`${API_BASE_URL}/health`)).json(); }
    catch { return { status: 'error' }; }
  }
}

export default new ApiService();
