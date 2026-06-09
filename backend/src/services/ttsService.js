import axios from 'axios';

class TTSService {
  constructor() {
    this.groqApiKey   = (process.env.GROQ_API_KEY        || '').trim();
    this.googleApiKey = (process.env.GOOGLE_TTS_API_KEY  || '').trim();
    this._hasGroq     = this.groqApiKey   && this.groqApiKey   !== 'your_groq_api_key_here';
    this._hasGoogle   = this.googleApiKey && this.googleApiKey !== 'your_google_tts_api_key_here';
  }

  getOrpheusVoice(voiceType) {
    return { professional:'aria', friendly:'nova', warm:'shimmer', calm:'echo' }[voiceType] || 'nova';
  }
  getGoogleVoice(voiceType) {
    const v = { professional:'en-US-Neural2-F', friendly:'en-US-Neural2-C', warm:'en-US-Neural2-E', calm:'en-US-Neural2-H' };
    return { languageCode:'en-US', name: v[voiceType] || v.friendly };
  }
  getSpeakingRate(voiceType) {
    return { professional:1.05, friendly:1.0, warm:0.95, calm:0.9 }[voiceType] || 1.0;
  }

  async generateSpeech(text, voiceType = 'friendly') {
    if (!text?.trim()) return null;
    if (this._hasGroq) {
      try { return await this._groqTTS(text, voiceType); }
      catch (err) { console.warn('[TTS] Groq failed, falling back to Google:', err.message); }
    }
    if (this._hasGoogle) return this._googleTTS(text, voiceType);
    return null;
  }

  async _groqTTS(text, voiceType) {
    const response = await axios.post(
      'https://api.groq.com/openai/v1/audio/speech',
      { model:'playai-tts', input:text, voice:this.getOrpheusVoice(voiceType), response_format:'wav' },
      { headers:{ Authorization:`Bearer ${this.groqApiKey}`, 'Content-Type':'application/json' },
        responseType:'arraybuffer', timeout:8000 }
    );
    return { audioData: Buffer.from(response.data).toString('base64'), mimeType:'audio/wav' };
  }

  async _googleTTS(text, voiceType) {
    try {
      const voice = this.getGoogleVoice(voiceType);
      const response = await axios.post(
        `https://texttospeech.googleapis.com/v1/text:synthesize?key=${this.googleApiKey}`,
        { input:{ text }, voice:{ languageCode:voice.languageCode, name:voice.name, ssmlGender:'FEMALE' },
          audioConfig:{ audioEncoding:'MP3', speakingRate:this.getSpeakingRate(voiceType), pitch:0, volumeGainDb:1,
            effectsProfileId:['headphone-class-device'] } },
        { headers:{ 'Content-Type':'application/json' }, timeout:10000 }
      );
      const audioContent = response.data?.audioContent;
      return audioContent ? { audioData:audioContent, mimeType:'audio/mpeg' } : null;
    } catch (err) {
      console.error('[TTS] Google error:', err.response?.data || err.message);
      return null;
    }
  }
}
export default new TTSService();
