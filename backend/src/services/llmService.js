import axios from 'axios';

const EMOTION_INSTRUCTION =
  'SYSTEM METADATA (invisible to the conversation): Before your response, output one emotion tag ' +
  'on its own: [EMOTION:X] where X is one of: neutral, happy, sad, angry, surprised, curious, ' +
  'thinking, concerned, analytical, engaged, calm, excited, proud, blushing, embarrassed. ' +
  'Pick whichever fits your genuine reaction. The tag must be the absolute first thing you output, ' +
  'nothing before it, and then continue with your normal reply as if the tag was never there. ' +
  'Do not reference the tag, acknowledge it, or let it change how naturally you speak.';


// ─── Provider constants ────────────────────────────────────────────────────────
const PROVIDER_OLLAMA    = 'ollama';
const PROVIDER_ANTHROPIC = 'anthropic';
const PROVIDER_OPENAI    = 'openai';

class LLMService {
  constructor() {
    // Active provider — set LLM_PROVIDER=ollama|anthropic|openai in .env
    this.provider = (process.env.LLM_PROVIDER || PROVIDER_OLLAMA).toLowerCase();

    // ── Ollama ──────────────────────────────────────────────────────────────
    this.ollamaUrl   = process.env.OLLAMA_URL   || 'http://localhost:11434';
    this.ollamaModel = process.env.OLLAMA_MODEL || 'gpt-oss:120b-cloud';

    // ── Anthropic Claude ────────────────────────────────────────────────────
    this.anthropicApiKey = process.env.ANTHROPIC_API_KEY || '';
    this.anthropicModel  = process.env.ANTHROPIC_MODEL   || 'claude-sonnet-4-20250514';

    // ── OpenAI GPT-4 ────────────────────────────────────────────────────────
    this.openaiApiKey = process.env.OPENAI_API_KEY || '';
    this.openaiModel  = process.env.OPENAI_MODEL   || 'gpt-4o';

    console.log(`[LLMService] Provider: ${this.provider}`);
  }

  /** Build the full system prompt with emotion instruction appended. */
  _buildSystemPrompt(systemPrompt) {
    const base = systemPrompt || '';
    return base
      ? `${base}\n\n${EMOTION_INSTRUCTION}`
      : EMOTION_INSTRUCTION;
  }

  /** Route to the correct provider and stream back text chunks via onChunk. */
  async generateResponse(messages, onChunk, systemPrompt) {
    const fullSystem = this._buildSystemPrompt(systemPrompt);

    switch (this.provider) {
      case PROVIDER_ANTHROPIC:
        return this._generateAnthropic(messages, onChunk, fullSystem);
      case PROVIDER_OPENAI:
        return this._generateOpenAI(messages, onChunk, fullSystem);
      case PROVIDER_OLLAMA:
      default:
        return this._generateOllama(messages, onChunk, fullSystem);
    }
  }

  // ─── Ollama ────────────────────────────────────────────────────────────────
  async _generateOllama(messages, onChunk, fullSystem) {
    const msgs = [
      { role: 'system', content: fullSystem },
      ...messages.filter(m => m.role !== 'system'),
    ];

    try {
      const response = await axios.post(
        `${this.ollamaUrl}/api/chat`,
        {
          model:    this.ollamaModel,
          messages: msgs,
          stream:   true,
          options:  { temperature: 0.85, top_p: 0.92 },
        },
        { responseType: 'stream' }
      );

      let fullResponse = '';
      return new Promise((resolve, reject) => {
        response.data.on('data', chunk => {
          try {
            for (const line of chunk.toString().split('\n').filter(l => l.trim())) {
              const parsed = JSON.parse(line);
              if (parsed.message?.content) {
                fullResponse += parsed.message.content;
                if (onChunk) onChunk(parsed.message.content);
              }
              if (parsed.done) resolve(fullResponse);
            }
          } catch (_) {}
        });
        response.data.on('end',   () => resolve(fullResponse));
        response.data.on('error', reject);
      });
    } catch (error) {
      console.error('[Ollama] Error:', error.message);
      throw error;
    }
  }

  // ─── Anthropic Claude ──────────────────────────────────────────────────────
  async _generateAnthropic(messages, onChunk, fullSystem) {
    if (!this.anthropicApiKey) {
      throw new Error('ANTHROPIC_API_KEY is not set in environment variables.');
    }

    const userMessages = messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role, content: m.content }));

    try {
      const response = await axios.post(
        'https://api.anthropic.com/v1/messages',
        {
          model:      this.anthropicModel,
          max_tokens: 2048,
          system:     fullSystem,
          messages:   userMessages,
          stream:     true,
        },
        {
          responseType: 'stream',
          headers: {
            'x-api-key':         this.anthropicApiKey,
            'anthropic-version': '2023-06-01',
            'content-type':      'application/json',
          },
        }
      );

      let fullResponse = '';
      return new Promise((resolve, reject) => {
        response.data.on('data', chunk => {
          try {
            for (const line of chunk.toString().split('\n').filter(l => l.trim())) {
              if (!line.startsWith('data: ')) continue;
              const data = JSON.parse(line.slice(6));
              if (data.type === 'content_block_delta' && data.delta?.type === 'text_delta') {
                const text = data.delta.text || '';
                fullResponse += text;
                if (onChunk) onChunk(text);
              }
              if (data.type === 'message_stop') resolve(fullResponse);
            }
          } catch (_) {}
        });
        response.data.on('end',   () => resolve(fullResponse));
        response.data.on('error', reject);
      });
    } catch (error) {
      console.error('[Anthropic] Error:', error.response?.data || error.message);
      throw error;
    }
  }

  // ─── OpenAI GPT-4 ──────────────────────────────────────────────────────────
  async _generateOpenAI(messages, onChunk, fullSystem) {
    if (!this.openaiApiKey) {
      throw new Error('OPENAI_API_KEY is not set in environment variables.');
    }

    const msgs = [
      { role: 'system', content: fullSystem },
      ...messages.filter(m => m.role !== 'system'),
    ];

    try {
      const response = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model:       this.openaiModel,
          messages:    msgs,
          stream:      true,
          temperature: 0.85,
          top_p:       0.92,
          max_tokens:  2048,
        },
        {
          responseType: 'stream',
          headers: {
            Authorization:  `Bearer ${this.openaiApiKey}`,
            'content-type': 'application/json',
          },
        }
      );

      let fullResponse = '';
      return new Promise((resolve, reject) => {
        response.data.on('data', chunk => {
          try {
            for (const line of chunk.toString().split('\n').filter(l => l.trim())) {
              if (!line.startsWith('data: ')) continue;
              const payload = line.slice(6);
              if (payload === '[DONE]') { resolve(fullResponse); continue; }
              const data = JSON.parse(payload);
              const text = data.choices?.[0]?.delta?.content || '';
              if (text) {
                fullResponse += text;
                if (onChunk) onChunk(text);
              }
            }
          } catch (_) {}
        });
        response.data.on('end',   () => resolve(fullResponse));
        response.data.on('error', reject);
      });
    } catch (error) {
      console.error('[OpenAI] Error:', error.response?.data || error.message);
      throw error;
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────
  detectIntent(message) {
    const m = message.toLowerCase();
    if (m.includes('side effect') || m.includes('dosage') || m.includes('drug')) return 'clinical';
    if (m.includes('code') || m.includes('debug')) return 'coding';
    if (m.includes('hello') || m.includes('hi '))  return 'conversational';
    return 'general';
  }

  /** Returns provider + model for health checks. */
  providerInfo() {
    switch (this.provider) {
      case PROVIDER_ANTHROPIC: return { provider: 'anthropic', model: this.anthropicModel };
      case PROVIDER_OPENAI:    return { provider: 'openai',    model: this.openaiModel    };
      default:                 return { provider: 'ollama',    model: this.ollamaModel    };
    }
  }
}

export default new LLMService();