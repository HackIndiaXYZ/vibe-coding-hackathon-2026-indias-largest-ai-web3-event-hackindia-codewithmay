import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * useSpeechRecognition
 *
 * Low-latency end-of-speech detection:
 *
 *  FAST path  (150 ms) — fires when the browser marks a result as `isFinal`
 *             AND the transcript ends with a sentence-ending punctuation
 *             equivalent (the browser adds "." "?" "!" to isFinal results).
 *             This catches "What time is it?" or "Hello." in ~150 ms.
 *
 *  NORMAL path (320 ms) — fires for plain statements that don't end with
 *             punctuation, e.g. "tell me a joke" (browser emits isFinal
 *             without "." for short declarative phrases).
 *
 *  SAFETY path (500 ms) — catches edge cases where the browser produces
 *             many isFinal segments in quick succession (fast speech).
 *             Prevents sending a half-complete sentence.
 *
 * All three are well under the original 600 ms.
 */

const SILENCE_MS_FAST   = 150;   // sentence-ending punctuation detected
const SILENCE_MS_NORMAL = 320;   // plain final segment, no punctuation
const SILENCE_MS_SAFETY = 500;   // fallback hard cap

// Punctuation that reliably indicates end of utterance
const SENTENCE_END_RE = /[.?!…][\s"']*$/;

export const useSpeechRecognition = () => {
  const [isListening, setIsListening]   = useState(false);
  const [transcript, setTranscript]     = useState('');
  const [isSupported, setIsSupported]   = useState(false);

  const recognitionRef       = useRef(null);
  const silenceTimerRef      = useRef(null);
  const onFinalTranscriptRef = useRef(null);
  const pendingFinalRef      = useRef('');

  const clearSilenceTimer = () => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  };

  /**
   * Schedule the send callback.
   * @param {number} ms — delay in milliseconds
   */
  const scheduleSend = (ms) => {
    clearSilenceTimer();
    silenceTimerRef.current = setTimeout(() => {
      const full = pendingFinalRef.current.trim();
      if (full && typeof onFinalTranscriptRef.current === 'function') {
        onFinalTranscriptRef.current(full);
      }
      pendingFinalRef.current = '';
      setTranscript('');
    }, ms);
  };

  useEffect(() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    setIsSupported(true);
    const recognition = new SpeechRecognition();
    recognitionRef.current = recognition;

    recognition.continuous     = true;
    recognition.interimResults = true;
    recognition.lang           = 'en-US';

    recognition.onresult = (event) => {
      let finalText   = '';
      let interimText = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const text = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalText               += text + ' ';
          pendingFinalRef.current += text + ' ';
        } else {
          interimText += text;
        }
      }

      // Always show live text immediately
      setTranscript(pendingFinalRef.current + interimText);

      if (finalText) {
        const accumulated = pendingFinalRef.current.trim();

        // Choose timer based on whether the utterance looks complete
        if (SENTENCE_END_RE.test(accumulated)) {
          // Ends with "." "?" "!" — very likely done speaking
          scheduleSend(SILENCE_MS_FAST);
        } else if (accumulated.split(/\s+/).length >= 3) {
          // At least 3 words and isFinal — probably a complete thought
          scheduleSend(SILENCE_MS_NORMAL);
        } else {
          // Very short so far — wait a bit longer in case more is coming
          scheduleSend(SILENCE_MS_SAFETY);
        }
      }
    };

    recognition.onerror = (event) => {
      if (event.error !== 'no-speech') {
        console.error('Speech recognition error:', event.error);
        setIsListening(false);
      }
    };

    recognition.onend = () => {
      if (recognitionRef.current?._shouldBeListening) {
        setTimeout(() => {
          if (recognitionRef.current?._shouldBeListening) {
            try { recognition.start(); } catch (_) {}
          }
        }, 100);
      }
    };

    return () => {
      clearSilenceTimer();
      recognition._shouldBeListening = false;
      try { recognition.stop(); } catch (_) {}
    };
  }, []);

  const isListeningRef = useRef(false);
  const syncListening  = (val) => { isListeningRef.current = val; setIsListening(val); };

  const startListening = useCallback((opts = {}) => {
    if (!recognitionRef.current || isListeningRef.current) return;
    onFinalTranscriptRef.current = opts.onFinalTranscript || null;
    pendingFinalRef.current = '';
    setTranscript('');
    clearSilenceTimer();
    recognitionRef.current._shouldBeListening = true;
    try {
      recognitionRef.current.start();
      syncListening(true);
    } catch (e) {
      console.warn('startListening error:', e.message);
    }
  }, []);

  const stopListening = useCallback(() => {
    clearSilenceTimer();
    if (!recognitionRef.current) return;
    recognitionRef.current._shouldBeListening = false;
    pendingFinalRef.current = '';
    syncListening(false);
    try { recognitionRef.current.stop(); } catch (_) {}
  }, []);

  const resetTranscript = useCallback(() => {
    pendingFinalRef.current = '';
    setTranscript('');
  }, []);

  return {
    isListening,
    transcript,
    isSupported,
    startListening,
    stopListening,
    resetTranscript,
  };
};
