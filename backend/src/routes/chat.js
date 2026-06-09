import express from 'express';
import fs from 'fs';
import path from 'path';
import llmService from '../services/llmService.js';
import ttsService from '../services/ttsService.js';

function loadAvatarConfig() {
  const configPath = process.env.AVATAR_CONFIG_PATH || path.resolve(process.cwd(), '../avatar.config.json');
  try {
    if (fs.existsSync(configPath)) return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) { console.warn(`[AvatarConfig] Failed to load: ${err.message}`); }
  return null;
}
const SERVER_AVATAR_CONFIG = loadAvatarConfig();

function resolveSystemPrompt(requestSystemPrompt) {
  if (requestSystemPrompt?.trim()) return requestSystemPrompt.trim();
  if (!SERVER_AVATAR_CONFIG) return '';
  if (SERVER_AVATAR_CONFIG.systemPrompt?.trim()) return SERVER_AVATAR_CONFIG.systemPrompt.trim();
  const parts = [];
  if (SERVER_AVATAR_CONFIG.name)   parts.push(`Your name is ${SERVER_AVATAR_CONFIG.name}.`);
  if (SERVER_AVATAR_CONFIG.role)   parts.push(`Your role is: ${SERVER_AVATAR_CONFIG.role}.`);
  if (SERVER_AVATAR_CONFIG.traits) parts.push(`Your personality traits are: ${SERVER_AVATAR_CONFIG.traits}.`);
  const behaviorMap = {
    concise:'Keep every reply to 2 sentences or fewer.',
    detailed:'Give thorough, well-structured explanations.',
    socratic:'Reply primarily with guiding questions.',
    empathetic:"Always acknowledge the user's feelings before responding to the content.",
    formal:'Use formal language and avoid contractions.',
    casual:'Speak in a relaxed, friendly, conversational tone.',
  };
  if (SERVER_AVATAR_CONFIG.dialogueBehavior) {
    const rule = behaviorMap[SERVER_AVATAR_CONFIG.dialogueBehavior];
    if (rule) parts.push(rule);
  }
  return parts.join(' ');
}

/**
 * Sentence splitter:
 * Splits on sentence-ending punctuation followed by whitespace (or end-of-string),
 * but avoids splitting on abbreviations (e.g. "Dr.", "Mr.", single-letter initials).
 * Returns { sentences, remainder } where remainder is the incomplete trailing fragment.
 */
function extractCompleteSentences(text) {
  // Split on . ! ? followed by optional closing quotes/parens and whitespace
  // Lookahead: must be followed by uppercase or end-of-string
  const parts = text.split(/(?<=[.!?][)'"]?)\s+(?=[A-Z"'\u2018\u201C]|$)/);
  if (parts.length <= 1) return { sentences: [], remainder: text };
  const sentences = parts.slice(0, -1);
  const remainder = parts[parts.length - 1];
  return { sentences, remainder };
}

async function runChatPipeline(payload, send, isDone = () => false) {
  const { message, history = [], systemPrompt, voiceType = 'friendly', reqId } = payload;
  if (!message) { send({ reqId, type: 'error', message: 'Message is required' }); return; }

  const resolvedSystemPrompt = resolveSystemPrompt(systemPrompt);
  const intent   = llmService.detectIntent(message);
  const messages = [...history.slice(-14), { role: 'user', content: message }];

  const hasGroq   = !!(process.env.GROQ_API_KEY && process.env.GROQ_API_KEY !== 'your_groq_api_key_here');
  const hasGoogle = !!((process.env.GOOGLE_TTS_API_KEY || '').trim() && (process.env.GOOGLE_TTS_API_KEY || '').trim() !== 'your_google_tts_api_key_here');
  const hasTTS    = hasGroq || hasGoogle;

  let fullResponse   = '';
  let sentenceBuffer = '';
  let audioSeq       = 0;

  // ── Minimum chars before firing the FIRST TTS chunk ──────────────────────
  // Lower = lower latency but potentially awkward short utterances.
  // 60 chars ≈ one short sentence ("Sure, I can help with that!").
  // We relax this to any complete sentence once the first chunk has fired.
  const FIRST_CHUNK_MIN_CHARS = 60;
  let firstChunkFired = false;

  /**
   * Fire TTS for a sentence asynchronously (non-blocking to LLM stream).
   * Returns the in-flight Promise so we can optionally await the last one.
   */
  const flushSentence = (sentence) => {
    const trimmed = sentence.trim();
    if (!trimmed || trimmed.length < 4 || !hasTTS) return null;
    const seq = audioSeq++;
    return (async () => {
      try {
        const audio = await ttsService.generateSpeech(trimmed, voiceType);
        if (audio?.audioData && !isDone()) {
          send({ reqId, type: 'audio_chunk', seq, sentence: trimmed, audio });
        }
      } catch (err) { console.error(`[TTS] seq=${seq} error:`, err.message); }
    })();
  };

  /**
   * Check the buffer and fire TTS if we have a complete sentence.
   * For the FIRST chunk we also require a minimum char threshold to
   * avoid a breathy one-word audio file arriving before the LLM has
   * streamed enough readable text.
   */
  const tryFlushBuffer = () => {
    const { sentences, remainder } = extractCompleteSentences(sentenceBuffer);
    if (sentences.length === 0) return;

    for (const s of sentences) {
      // First chunk: only fire if we have enough context
      if (!firstChunkFired) {
        const totalChars = sentences.join(' ').length;
        if (totalChars < FIRST_CHUNK_MIN_CHARS) {
          // Not enough yet — put it back and wait for more
          sentenceBuffer = sentences.join(' ') + (remainder ? ' ' + remainder : '');
          return;
        }
        firstChunkFired = true;
      }
      flushSentence(s);
    }
    sentenceBuffer = remainder;
  };

  try {
    await llmService.generateResponse(
      messages,
      (chunk) => {
        if (isDone()) return;
        fullResponse   += chunk;
        sentenceBuffer += chunk;
        send({ reqId, type: 'chunk', content: chunk, intent });
        tryFlushBuffer();
      },
      resolvedSystemPrompt
    );

    // Flush any remaining text in the buffer
    if (sentenceBuffer.trim()) {
      flushSentence(sentenceBuffer.trim());
      sentenceBuffer = '';
    }

    // Send complete immediately — don't wait for TTS audio_chunks
    if (!isDone()) {
      send({ reqId, type: 'complete', content: fullResponse, intent, audio: null, usedChunkedAudio: hasTTS });
    }
  } catch (error) {
    console.error('[Chat pipeline] error:', error);
    if (!isDone()) send({ reqId, type: 'error', message: error.message });
  }
}

// WebSocket handler (called from server.js)
export async function handleWebSocket(ws, payload) {
  const send   = (obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };
  const isDone = () => ws.readyState !== 1;
  await runChatPipeline(payload, send, isDone);
}

// HTTP SSE handler (legacy fallback)
const router = express.Router();

router.post('/chat', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  const send   = (obj) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };
  const isDone = () => res.writableEnded;
  await runChatPipeline(req.body, send, isDone);
  if (!res.writableEnded) res.end();
});

router.get('/health', (req, res) => {
  const hasGroq   = !!(process.env.GROQ_API_KEY && process.env.GROQ_API_KEY !== 'your_groq_api_key_here');
  const hasGoogle = !!((process.env.GOOGLE_TTS_API_KEY || '').trim());
  const ttsMode   = hasGroq ? 'groq-orpheus' : hasGoogle ? 'google-neural2' : 'browser-fallback';
  const { provider, model } = llmService.providerInfo();
  res.json({ status: 'ok', provider, model, tts: ttsMode, transport: 'websocket+sse', timestamp: new Date().toISOString() });
});

export default router;
