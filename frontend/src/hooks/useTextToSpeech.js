import { useState, useRef, useCallback, useEffect } from 'react';

// ── Phoneme timeline generator ────────────────────────────────────────────────
const DIGRAPH_MAP = {
  'ai': 'A', 'ay': 'A', 'ae': 'A', 'au': 'O', 'aw': 'O',
  'ee': 'I', 'ea': 'I', 'ei': 'I', 'ey': 'I',
  'oo': 'U', 'ou': 'U', 'ow': 'O', 'oe': 'O',
  'ie': 'I', 'ue': 'U', 'ui': 'I',
  'ch': null, 'sh': null, 'th': null, 'wh': null, 'ph': null, 'gh': null,
  'ng': null, 'ck': null,
};
const LETTER_MAP = {
  'a': 'A', 'e': 'I', 'i': 'I', 'o': 'O', 'u': 'U',
  'b': 'A', 'p': 'A', 'm': 'A',
  'f': null, 'v': null, 'w': null, 'q': null,
  'l': null, 'n': null, 't': null, 'd': null,
  'r': null, 's': null, 'z': null, 'k': null,
  'g': null, 'h': null, 'j': null, 'x': null,
  'y': null, 'c': null,
};

/**
 * Build a phoneme timeline from plain text + estimated audio duration.
 * Returns an array of { time: number, phoneme: string } sorted by time.
 */
function generatePhonemeTimeline(text, durationSecs) {
  if (!text || durationSecs <= 0) return [];
  const cleaned = text.toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const words = cleaned.split(' ').filter(Boolean);
  if (words.length === 0) return [];

  const phonemes = [];
  for (const word of words) {
    let i = 0;
    while (i < word.length) {
      const di = word.slice(i, i + 2);
      if (di.length === 2 && di in DIGRAPH_MAP) {
        const shape = DIGRAPH_MAP[di];
        phonemes.push(shape ?? 'Silence');
        i += 2;
      } else {
        const ch = word[i];
        const shape = ch in LETTER_MAP ? LETTER_MAP[ch] : null;
        phonemes.push(shape ?? 'Silence');
        i++;
      }
    }
    phonemes.push('Silence');
  }

  const merged = [];
  for (const p of phonemes) {
    if (merged.length === 0) { merged.push(p); continue; }
    const last = merged[merged.length - 1];
    if (p === 'Silence' && last === 'Silence') continue;
    if (p === last && p !== 'Silence') continue;
    merged.push(p);
  }
  if (merged.length === 0) return [];

  const weights = merged.map(p => (p === 'Silence' ? 0.35 : 1.0));
  const totalWeight = weights.reduce((s, w) => s + w, 0);
  const events = [];
  let t = 0;
  for (let i = 0; i < merged.length; i++) {
    events.push({ time: parseFloat(t.toFixed(4)), phoneme: merged[i] });
    t += (weights[i] / totalWeight) * durationSecs;
  }
  events.push({ time: parseFloat(durationSecs.toFixed(4)), phoneme: 'Silence' });
  return events;
}

/**
 * Estimate TTS audio duration from word count and speaking rate.
 * ~130 wpm baseline, adjusted by rate. Returns seconds.
 */
function estimateDuration(text, rate = 1.0) {
  const wordCount = (text || '').trim().split(/\s+/).filter(Boolean).length;
  return (wordCount / 130) * 60 * (1 / Math.max(0.5, rate));
}

export const useTextToSpeech = (settings = {}) => {
  const [isSpeaking, setIsSpeaking]           = useState(false);
  const [audioAmplitude, setAudioAmplitude]   = useState(0);
  const [availableVoices, setAvailableVoices] = useState([]);
  const [phonemeTimeline, setPhonemeTimeline] = useState(null);

  const pendingPhonemeTextRef = useRef(null);

  const audioContextRef  = useRef(null);
  const audioRef         = useRef(null);
  const rafRef           = useRef(null);
  const utteranceRef     = useRef(null);

  // ── Audio queue for chunked TTS playback ──────────────────────────────────
  const chunkBufferRef    = useRef({});
  const nextSeqRef        = useRef(0);
  const isPlayingChunkRef = useRef(false);
  const chunkedModeRef    = useRef(false);

  const settingsRef = useRef(settings);
  useEffect(() => { settingsRef.current = settings; }, [settings]);

  // Load voices
  useEffect(() => {
    const load = () => {
      const voices = window.speechSynthesis?.getVoices() || [];
      if (voices.length > 0) setAvailableVoices(voices);
    };
    load();
    window.speechSynthesis?.addEventListener('voiceschanged', load);
    return () => window.speechSynthesis?.removeEventListener('voiceschanged', load);
  }, []);

  // ── Animation frame helpers ───────────────────────────────────────────────
  const stopRAF = useCallback(() => {
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    setAudioAmplitude(0);
  }, []);

  const startSimulation = useCallback(() => {
    stopRAF();
    let t = 0;
    const tick = () => {
      // Use overlapping sine waves at different frequencies to simulate natural speech rhythm.
      // Avoid pow() exaggeration that creates extreme peaks — keep amplitude moderate (max ~0.45)
      // so haru_greeter's addDelta never pushes the mouth to extreme-open.
      const syllable = Math.max(0, Math.sin(t * 7.5) * 0.5 + Math.sin(t * 13) * 0.2);
      const phrase   = Math.max(0.2, Math.sin(t * 1.1) * 0.35 + 0.65);
      const noise    = Math.random() * 0.04;
      setAudioAmplitude(Math.min(0.45, (syllable * phrase * 0.55 + noise * phrase)));
      t += 0.016;
      rafRef.current = requestAnimationFrame(tick);
    };
    tick();
  }, [stopRAF]);

  const startAudioAnalysis = useCallback((audio, text = null) => {
    stopRAF();

    // ── EAGER phoneme timeline: build immediately from text + estimated duration.
    // This fires BEFORE loadedmetadata so lip sync begins the instant audio plays,
    // not 50-150ms later when the browser parses the audio header.
    const textToUse = text || pendingPhonemeTextRef.current;
    if (textToUse) {
      const rate = settingsRef.current.speechSpeed ?? 1.0;
      const estDur = estimateDuration(textToUse, rate);
      setPhonemeTimeline(generatePhonemeTimeline(textToUse, estDur));
      pendingPhonemeTextRef.current = null;

      // Refine with actual duration once available (usually within a few ms)
      const refineTimeline = () => {
        const dur = audio.duration;
        if (dur && isFinite(dur) && dur > 0 && Math.abs(dur - estDur) > 0.1) {
          setPhonemeTimeline(generatePhonemeTimeline(textToUse, dur));
        }
      };
      if (audio.duration && isFinite(audio.duration)) {
        refineTimeline();
      } else {
        audio.addEventListener('loadedmetadata', refineTimeline, { once: true });
      }
    }

    try {
      if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
        audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();
      }
      const ctx = audioContextRef.current;
      if (ctx.state === 'suspended') ctx.resume();

      if (!audio._sourceNode) {
        audio._sourceNode = ctx.createMediaElementSource(audio);
      }
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.15;
      audio._sourceNode.connect(analyser);
      analyser.connect(ctx.destination);

      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteTimeDomainData(data);
        let sumSq = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sumSq += v * v;
        }
        const raw    = Math.sqrt(sumSq / data.length);
        // Scale gently: 3.5x gain (was 5.5x) then pow(0.75) (was 0.65) for softer curve.
        // Cap at 0.5 — haru_greeter's baked motion already opens the mouth; our addDelta
        // only needs to modulate slightly, not drive it to max. This prevents wide-open overshoot.
        const scaled = Math.max(0, raw - 0.005) * 3.5;
        setAudioAmplitude(Math.min(0.5, Math.pow(scaled, 0.75)));
        rafRef.current = requestAnimationFrame(tick);
      };
      tick();
    } catch (e) {
      console.warn('Web Audio failed, falling back to simulation:', e.message);
      startSimulation();
    }
  }, [stopRAF, startSimulation]);

  // ── Web Speech API fallback ───────────────────────────────────────────────
  const speak = useCallback((text) => {
    if (!text?.trim()) return;
    if (settingsRef.current.voiceEnabled === false) return;
    window.speechSynthesis.cancel();

    const doSpeak = () => {
      const s = settingsRef.current;
      const utterance = new SpeechSynthesisUtterance(text);
      utteranceRef.current = utterance;
      const voices = window.speechSynthesis.getVoices();

      if (s.selectedVoiceURI) {
        const picked = voices.find(v => v.voiceURI === s.selectedVoiceURI);
        if (picked) utterance.voice = picked;
      } else {
        const female = voices.find(v =>
          /female|woman/i.test(v.name) ||
          /samantha|victoria|karen|moira|fiona|tessa|aria|jenny|ana|michelle|emma|zira|susan|hazel/i.test(v.name)
        ) || voices.find(v => v.lang.startsWith('en-')) || null;
        if (female) utterance.voice = female;
      }

      utterance.lang   = 'en-US';
      utterance.rate   = s.speechSpeed  ?? 1.0;
      utterance.pitch  = s.speechPitch  ?? 1.05;
      utterance.volume = s.speechVolume ?? 1.0;

      // Build timeline eagerly before speech starts
      const estDuration = estimateDuration(text, utterance.rate);

      utterance.onstart = () => {
        setIsSpeaking(true);
        startSimulation();
        setPhonemeTimeline(generatePhonemeTimeline(text, estDuration));
      };
      utterance.onend   = () => { setIsSpeaking(false); stopRAF(); setPhonemeTimeline(null); };
      utterance.onerror = (e) => {
        if (e.error !== 'interrupted') console.error('SpeechSynthesis:', e.error);
        setIsSpeaking(false); stopRAF(); setPhonemeTimeline(null);
      };

      window.speechSynthesis.speak(utterance);
    };

    if (window.speechSynthesis.getVoices().length > 0) {
      doSpeak();
    } else {
      window.speechSynthesis.onvoiceschanged = () => {
        window.speechSynthesis.onvoiceschanged = null;
        doSpeak();
      };
    }
  }, [startSimulation, stopRAF]);

  // ── Single base64 audio playback ──────────────────────────────────────────
  const playAudio = useCallback((audioData, mimeType = 'audio/mpeg', text = null) => {
    if (!audioData) return;
    if (settingsRef.current.voiceEnabled === false) return;
    window.speechSynthesis.cancel();
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    stopRAF();

    if (text) pendingPhonemeTextRef.current = text;

    try {
      const audio = new Audio(`data:${mimeType};base64,${audioData}`);
      audioRef.current = audio;
      audio.volume = settingsRef.current.speechVolume ?? 1.0;

      audio.onplay  = () => { setIsSpeaking(true);  startAudioAnalysis(audio, text); };
      audio.onended = () => { setIsSpeaking(false); stopRAF(); setPhonemeTimeline(null); };
      audio.onerror = () => { setIsSpeaking(false); stopRAF(); setPhonemeTimeline(null); };

      const p = audio.play();
      if (p) p.catch(err => {
        console.warn('Autoplay blocked:', err.message);
        setIsSpeaking(false); stopRAF();
      });
    } catch (e) {
      console.error('playAudio error:', e);
      setIsSpeaking(false);
    }
  }, [startAudioAnalysis, stopRAF]);

  // ── Chunked audio queue ───────────────────────────────────────────────────

  const resetQueue = useCallback((text = null) => {
    chunkBufferRef.current        = {};
    nextSeqRef.current            = 0;
    isPlayingChunkRef.current     = false;
    chunkedModeRef.current        = true;
    pendingPhonemeTextRef.current = text ?? null;
  }, []);

  const drainQueueRef = useRef(null);

  drainQueueRef.current = () => {
    if (isPlayingChunkRef.current) return;
    const seq   = nextSeqRef.current;
    const entry = chunkBufferRef.current[seq];
    if (!entry) return;

    isPlayingChunkRef.current = true;
    nextSeqRef.current = seq + 1;
    delete chunkBufferRef.current[seq];

    const { audioData, mimeType, sentence } = entry;

    window.speechSynthesis.cancel();
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }

    try {
      const audio = new Audio(`data:${mimeType};base64,${audioData}`);
      audioRef.current = audio;
      audio.volume = settingsRef.current.speechVolume ?? 1.0;

      audio.onplay = () => {
        setIsSpeaking(true);
        // Pass sentence text so phoneme timeline is built eagerly
        startAudioAnalysis(audio, sentence || pendingPhonemeTextRef.current);
      };

      audio.onended = () => {
        isPlayingChunkRef.current = false;
        const hasMore = Object.keys(chunkBufferRef.current).length > 0;
        if (hasMore) {
          drainQueueRef.current();
        } else if (!chunkedModeRef.current) {
          setIsSpeaking(false);
          stopRAF();
          setPhonemeTimeline(null);
        }
      };

      audio.onerror = () => {
        console.warn('[TTS queue] Audio element error for seq', seq);
        isPlayingChunkRef.current = false;
        drainQueueRef.current();
      };

      const p = audio.play();
      if (p) p.catch(err => {
        console.warn('[TTS queue] Autoplay blocked for seq', seq, err.message);
        isPlayingChunkRef.current = false;
        drainQueueRef.current();
      });
    } catch (e) {
      console.error('[TTS queue] Error playing chunk seq', seq, e);
      isPlayingChunkRef.current = false;
      drainQueueRef.current();
    }
  };

  const drainQueue = useCallback(() => { drainQueueRef.current(); }, []);

  const enqueueChunk = useCallback((seq, audio, sentence = null) => {
    if (!audio?.audioData) return;
    if (settingsRef.current.voiceEnabled === false) return;

    chunkBufferRef.current[seq] = {
      audioData: audio.audioData,
      mimeType:  audio.mimeType || 'audio/mpeg',
      sentence,  // Store sentence text for eager phoneme timeline
    };
    drainQueue();
  }, [drainQueue]);

  const finaliseQueue = useCallback((usedChunkedAudio, fullText) => {
    chunkedModeRef.current = false;

    if (!usedChunkedAudio) {
      if (fullText) speak(fullText);
      return;
    }

    if (fullText) pendingPhonemeTextRef.current = fullText;

    if (!isPlayingChunkRef.current && Object.keys(chunkBufferRef.current).length === 0) {
      setIsSpeaking(false);
      stopRAF();
    }
  }, [speak, stopRAF]);

  // ── Stop everything ───────────────────────────────────────────────────────
  const stop = useCallback(() => {
    window.speechSynthesis.cancel();
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    isPlayingChunkRef.current     = false;
    chunkBufferRef.current        = {};
    chunkedModeRef.current        = false;
    pendingPhonemeTextRef.current = null;
    setIsSpeaking(false);
    stopRAF();
    setPhonemeTimeline(null);
  }, [stopRAF]);

  return {
    isSpeaking,
    audioAmplitude,
    phonemeTimeline,
    availableVoices,
    speak,
    playAudio,
    enqueueChunk,
    resetQueue,
    finaliseQueue,
    stop,
  };
};
