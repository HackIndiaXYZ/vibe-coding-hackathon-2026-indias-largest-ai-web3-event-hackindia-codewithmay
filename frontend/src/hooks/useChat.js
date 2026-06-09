import { useState, useCallback, useRef } from 'react';
import apiService from '../services/apiService';

// Regex to extract and strip the LLM-injected emotion tag
const EMOTION_TAG_RE = /^\[EMOTION:([a-z]+)\]\s*/i;

/**
 * Strip [EMOTION:X] from the start of text and return { emotion, text }.
 * Falls back to legacy regex detection if no tag is present.
 */
function parseEmotion(text) {
  const match = text.match(EMOTION_TAG_RE);
  if (match) {
    return { emotion: match[1].toLowerCase(), text: text.slice(match[0].length) };
  }
  if (/angry|frustrat|unacceptable|that's wrong|incorrect/i.test(text))  return { emotion: 'angry',     text };
  if (/sad|sorry|unfortunat|terrible|concern|worried/i.test(text))       return { emotion: 'sad',       text };
  if (/great|excellent|perfect|wonderful|happy|glad|love/i.test(text))   return { emotion: 'happy',     text };
  if (/surprised|wow|really\?|unexpected|interesting!/i.test(text))      return { emotion: 'surprised', text };
  if (/blush|embarrass|awkward/i.test(text))                             return { emotion: 'blushing',  text };
  return { emotion: null, text };
}

export const useChat = () => {
  const [messages, setMessages]           = useState([]);
  const [isLoading, setIsLoading]         = useState(false);
  const [currentIntent, setCurrentIntent] = useState('general');

  // Ref so callbacks always see fresh messages without stale closures
  const messagesRef = useRef(messages);
  const setMessagesAndRef = (updater) => {
    setMessages(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      messagesRef.current = next;
      return next;
    });
  };

  /**
   * Gate: holds text chunks until the first audio_chunk arrives.
   * This ensures text and voice appear together.
   *
   * State machine:
   *   'waiting'  → first audio_chunk not yet received; buffer text
   *   'released' → first audio_chunk arrived; flush buffer + stream live
   *   'disabled' → TTS unavailable (no key); stream text immediately
   */
  const gateRef            = useRef('waiting');
  const gateTextBufferRef  = useRef('');   // text accumulated while gate is 'waiting'
  const gateIntentRef      = useRef('general');

  /**
   * @param {string}   userMessage
   * @param {object}   persona
   * @param {Function} onAudioReceived        (audio|null, fullText, usedChunkedAudio) => void
   * @param {any}      _reserved              reserved, pass null
   * @param {Function} onEmotionDetected      (emotion: string) => void   (optional)
   * @param {Function} onAudioChunk           (seq, audio, sentence) => void  (optional, for chunked TTS)
   */
  const sendMessage = useCallback(async (
    userMessage,
    persona,
    onAudioReceived,
    _reserved = null,
    onEmotionDetected = null,
    onAudioChunk = null,
  ) => {
    if (!userMessage.trim()) return;

    // Reset gate state for this new request
    gateRef.current           = 'waiting';
    gateTextBufferRef.current = '';
    gateIntentRef.current     = 'general';

    const userMsg      = { id: Date.now(),     role: 'user',      content: userMessage, timestamp: new Date() };
    // assistantMsg starts with content null — it will NOT render until gate opens
    const assistantMsg = { id: Date.now() + 1, role: 'assistant', content: null,        timestamp: new Date(), intent: 'general' };

    const historySnapshot = messagesRef.current;
    setMessagesAndRef(prev => [...prev, userMsg, assistantMsg]);
    setIsLoading(true);

    // Running buffer to detect the emotion tag which may span multiple chunks
    let chunkAccumulator = '';
    let emotionParsed    = false;
    let emotionFromTag   = null;

    // ── Gate flush: called once when first audio arrives ─────────────────────
    const releaseGate = (intent) => {
      if (gateRef.current === 'released' || gateRef.current === 'disabled') return;
      gateRef.current = 'released';
      const buffered = gateTextBufferRef.current;
      gateTextBufferRef.current = '';
      if (!buffered) return;
      // Flush all buffered text into the assistant bubble at once
      setCurrentIntent(intent || 'general');
      setMessagesAndRef(prev => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last?.role === 'assistant') {
          last.content = buffered;
          last.intent  = intent || 'general';
        }
        return next;
      });
    };

    // ── Text accumulation (strips emotion tag, then buffers or streams) ──────
    const pushText = (chunk, intent) => {
      setCurrentIntent(intent || 'general');
      gateIntentRef.current = intent || 'general';

      if (gateRef.current === 'waiting') {
        // Still waiting for first audio chunk — just accumulate
        gateTextBufferRef.current += chunk;
      } else {
        // Gate open — stream directly
        setMessagesAndRef(prev => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last?.role === 'assistant') {
            last.content = (last.content ?? '') + chunk;
            last.intent  = intent || 'general';
          }
          return next;
        });
      }
    };

    // ── onAudioChunk wrapper: opens the gate on first chunk ──────────────────
    const wrappedOnAudioChunk = (seq, audio, sentence) => {
      // Open gate so text renders together with audio
      releaseGate(gateIntentRef.current);
      if (onAudioChunk) onAudioChunk(seq, audio, sentence);
    };

    await apiService.sendMessage(
      userMessage,
      historySnapshot,
      persona,

      // onChunk — live text streaming (with emotion-tag stripping)
      (chunk, intent) => {
        if (!emotionParsed) {
          chunkAccumulator += chunk;
          const match = chunkAccumulator.match(EMOTION_TAG_RE);
          if (match) {
            emotionParsed  = true;
            emotionFromTag = match[1].toLowerCase();
            chunkAccumulator = chunkAccumulator.slice(match[0].length);
            if (typeof onEmotionDetected === 'function') onEmotionDetected(emotionFromTag);
            if (chunkAccumulator) pushText(chunkAccumulator, intent);
          } else if (chunkAccumulator.length > 80) {
            // Tag not found in first 80 chars — give up waiting, flush
            emotionParsed = true;
            pushText(chunkAccumulator, intent);
            chunkAccumulator = '';
          }
          // else: still accumulating, tag might be split across chunks
        } else {
          pushText(chunk, intent);
        }
      },

      // onComplete
      (fullContent, intent, audio, usedChunkedAudio) => {
        setIsLoading(false);
        setCurrentIntent(intent || 'general');

        const { emotion, text: cleanContent } = parseEmotion(fullContent);

        if (!usedChunkedAudio) {
          // No chunked TTS — gate will never open via audio_chunk.
          // Open it now (text + single-audio arrive together in onAudioReceived).
          gateRef.current = 'disabled';
          // Write full clean content into assistant bubble
          setMessagesAndRef(prev => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last?.role === 'assistant') {
              last.content = cleanContent;
              last.intent  = intent;
              last.audio   = audio;
            }
            return next;
          });
        } else {
          // Chunked mode: gate may or may not have opened yet.
          // If it hasn't (no audio chunks received — e.g. TTS errored), open it now.
          if (gateRef.current === 'waiting') {
            gateRef.current = 'released';
            // Write full clean content at once
            setMessagesAndRef(prev => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (last?.role === 'assistant') {
                last.content = cleanContent;
                last.intent  = intent;
              }
              return next;
            });
          } else {
            // Gate already open — just set final clean content
            setMessagesAndRef(prev => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (last?.role === 'assistant') {
                last.content = cleanContent;
                last.intent  = intent;
              }
              return next;
            });
          }
        }

        if (onAudioReceived) onAudioReceived(audio, cleanContent, usedChunkedAudio);

        const finalEmotion = emotionFromTag || emotion;
        if (finalEmotion && typeof onEmotionDetected === 'function') {
          onEmotionDetected(finalEmotion);
        }
      },

      // onError
      (error) => {
        console.error('Chat error:', error);
        setIsLoading(false);
        gateRef.current = 'disabled';
        setMessagesAndRef(prev => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last?.role === 'assistant') {
            last.content = 'Sorry, I encountered an error. Please try again.';
            last.error   = true;
          }
          return next;
        });
      },

      // onAudioChunk — wrapped so first chunk opens the gate
      wrappedOnAudioChunk,
    );
  }, []);

  const clearMessages = useCallback(() => {
    setMessagesAndRef([]);
    setCurrentIntent('general');
  }, []);

  const restoreMessages = useCallback((saved) => {
    setMessagesAndRef(saved);
  }, []);

  return { messages, isLoading, currentIntent, sendMessage, clearMessages, restoreMessages };
};
