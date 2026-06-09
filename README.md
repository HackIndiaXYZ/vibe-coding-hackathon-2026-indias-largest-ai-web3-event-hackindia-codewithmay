# VibeFlow AI

**Talk Naturally. Experience AI.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org)
[![React](https://img.shields.io/badge/React-18-61DAFB.svg)](https://reactjs.org)
[![Vite](https://img.shields.io/badge/Vite-5-646CFF.svg)](https://vitejs.dev)
[![Live2D](https://img.shields.io/badge/Live2D-Cubism%204-pink.svg)](https://www.live2d.com)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ED.svg)](docker-compose.yml)
[![HackIndia 2026](https://img.shields.io/badge/HackIndia-2026-orange.svg)](https://hackindia.xyz)

---

## Demo

> **Watch VibeFlow AI in action**

[![Demo Video](https://img.shields.io/badge/Watch%20Demo-YouTube-red)](https://youtu.be/l-aC46OeKzs)

---

## Overview

**VibeFlow AI** is a real-time conversational AI avatar platform that enables users to interact with intelligent AI personas using voice, text, and animated avatars. The platform supports multiple personalities, natural conversations, and immersive human-like interactions — all running natively in the browser with zero installation required.

Users can engage with richly animated Live2D avatar characters that lip-sync, express emotion, and respond dynamically to natural speech. VibeFlow AI demonstrates what the next generation of human-computer interaction looks like: not a chatbot in a box, but a presence you can talk to.

---

## ✨ Key Features

### Real-Time Conversational AI

- **Continuous voice input** via the browser-native Web Speech API with 600 ms silence detection for natural, human-like turn-taking — no push-to-talk required.
- **Token-streaming responses** delivered via Server-Sent Events (SSE) for instant on-screen rendering as the model generates.
- **Multi-turn memory** — the last 14 messages of conversation history are sent on every request, maintaining coherent conversational context throughout a session.
- **Intent routing** — lightweight keyword classification identifies `clinical`, `coding`, `conversational`, and `general` intents to intelligently modulate response behaviour.

### Expressive Avatar System

- **Live2D Cubism 4 rendering** — full WebGL-based avatars with physics simulation, eye-blink, and procedural idle motion.
- **Real-time lip sync** — Web Audio API amplitude data is mapped through a custom `AmplitudeProvider → CubismLipSyncUpdater` pipeline with asymmetric attack/release smoothing for natural mouth movement.
- **Emotion-driven expressions** — the LLM prefixes every response with `[EMOTION:X]`; the frontend parses the tag and triggers matching `.exp3.json` expressions: `happy`, `sad`, `angry`, `surprised`, `blushing`, `calm`, `analytical`, and more.
- **Dynamic motion pools** — speaking and idle motion sets are triggered seamlessly by avatar state transitions.

### Text-to-Speech Pipeline

- **Google Cloud Neural2 TTS** (primary) — per-persona neural voices with configurable speaking rate; responses are synthesised sentence-by-sentence for minimal first-audio latency.
- **Web Speech API** (fallback) — fully client-side synthesis with zero backend dependency; activates automatically when no Google TTS key is configured.
- **Chunked, ordered audio delivery** — `audio_chunk` SSE events carry base64 MP3 segments keyed by sequence number; a client-side buffer guarantees correct playback order.

### Multi-Persona System

- **4 built-in AI personas**, each with a distinct voice, personality, and conversational style:

  | Persona | Role | Personality |
  |---|---|---|
  | Haru | Pharmacist | Analytical, precise, knowledge-driven |
  | Izumi | Registered Nurse | Caring, safety-focused, empathetic |
  | Emma Rodriguez | Dietitian | Holistic, supportive, lifestyle-aware |
  | Dr. Aiko Tanaka | Psychologist | Reflective, emotionally intelligent |

- **Server-side persona override** — deploy custom personas via `avatar.config.json` + `AVATAR_CONFIG_PATH`. Supports configurable `dialogueBehavior`: `concise`, `detailed`, `socratic`, `empathetic`, `formal`, or `casual`.

### Visual Intelligence

- **Contextual image injection** — when visually relevant, the LLM embeds `[IMAGE_QUERY:terms|N]` tags. The backend fetches real images via SerpApi and falls back to deterministic Picsum placeholders.
- **Overlay image panel** — retrieved images render in a dedicated overlay alongside the active avatar.

### UI & Interaction Modes

- **Split-screen layout** — avatar panel and chat panel displayed side by side on desktop.
- **Full-screen avatar mode** — chat panel collapses; conversation renders as an overlaid subtitle strip.
- **Mobile-responsive** — `useIsMobile()` hook drives layout switching at the 768 px breakpoint. Tested on Chrome (Android) and Safari (iOS).
- **Settings panel** — voice selection, TTS provider toggle, speech recognition language, and provider health check.
- **Avatar transform panel** — pan, zoom, and reposition the avatar canvas at runtime.

---

## 🏗 Architecture

VibeFlow AI follows a clean client–server split with a stateless Express backend and a rich React/WebGL frontend. All conversation state lives in the browser; each request includes full history, making the backend trivially horizontally scalable.

```
┌─────────────────────────────────────────────────────────┐
│                        BROWSER                          │
│                                                         │
│  User Speech                                            │
│      ↓                                                  │
│  Web Speech API  (continuous, 600 ms silence timer)     │
│      ↓                                                  │
│  useChat.sendMessage()  ──────── POST /api/chat ──────► │
│                                                         │
│  ◄── chunk events       (text tokens, SSE)              │
│  ◄── audio_chunk events (base64 MP3, sequence id)       │
│  ◄── complete event                                     │
│      ↓                                                  │
│  Emotion parser   →  Live2DManager.setEmotion()         │
│  Image parser     →  ImageOverlay.jsx                   │
│  Audio queue      →  Web Audio API amplitude analysis   │
│      ↓                                                  │
│  AmplitudeProvider  →  CubismLipSyncUpdater             │
│      ↓                                                  │
│  Live2D Cubism WebGL Canvas                             │
│  (physics · eye-blink · motion · expression)            │
└─────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│                   EXPRESS BACKEND                       │
│                                                         │
│  POST /api/chat  (SSE)                                  │
│      ↓                                                  │
│  resolveSystemPrompt()  (request > server config)       │
│      ↓                                                  │
│  LLMService.generateResponse()                          │
│  ├── Ollama          local · NDJSON streaming           │
│  ├── Anthropic Claude    SSE · content_block_delta      │
│  └── OpenAI GPT-4        SSE · choices[0].delta        │
│      ↓                                                  │
│  Sentence splitter  →  TTSService.generateSpeech()      │
│  ├── Google Cloud Neural2  TTS                          │
│  └── null  (browser Web Speech API fallback)            │
│      ↓                                                  │
│  ImageService.search()  (SerpApi / Picsum fallback)     │
└─────────────────────────────────────────────────────────┘
```

---

## 🛠 Tech Stack

| Layer | Technology |
|---|---|
| **Frontend framework** | React 18, Vite 5, TypeScript (Live2D layer), Lucide React |
| **Styling** | Tailwind CSS 3, PostCSS, custom CSS animations |
| **Avatar rendering** | Live2D Cubism SDK 4 (WebGL) — `.moc3`, `.model3.json`, `.exp3.json`, `.motion3.json` |
| **Lip sync** | Custom `AmplitudeProvider → CubismLipSyncUpdater`, Web Audio API analyser node |
| **Speech input** | Web Speech API — `webkitSpeechRecognition`, continuous mode |
| **Text-to-speech** | Google Cloud Neural2 TTS (primary) · Web Speech API (fallback) |
| **Backend** | Node.js 18, Express 4 (ESM), `node --watch` dev server |
| **LLM providers** | Ollama (local) · Anthropic Claude API · OpenAI GPT-4 API |
| **Streaming transport** | Server-Sent Events — `text/event-stream` |
| **Image search** | SerpApi Google Images engine · Picsum fallback |
| **Containerisation** | Docker · Docker Compose 3.9 |

---

## 📁 Project Structure

```
vibeflow-ai/
├── avatar.config.json           # Server-side persona override template
├── docker-compose.yml           # Multi-service Docker orchestration
│
├── backend/
│   ├── Dockerfile               # Node 18 Alpine image
│   ├── .env.example             # Environment variable reference
│   └── src/
│       ├── server.js            # Express app, CORS, middleware
│       ├── routes/
│       │   └── chat.js          # POST /api/chat · GET /api/health · GET /api/images
│       └── services/
│           ├── llmService.js    # Ollama / Anthropic / OpenAI provider abstraction
│           ├── ttsService.js    # Google Neural2 TTS, per-persona voice config
│           ├── imageService.js  # SerpApi + Picsum fallback
│           └── apiService.js    # Shared HTTP helpers
│
└── frontend/
    ├── public/
    │   ├── live2dcubismcore.min.js   # Live2D Cubism Core (WebAssembly)
    │   ├── personas.json             # AI persona definitions
    │   ├── Shaders/                  # Live2D WebGL GLSL shaders
    │   └── models/
    │       ├── haru/                 # Pharmacist persona — expressions, motions, textures
    │       ├── haru_greeter/         # Psychologist persona — expressions, motions, textures
    │       └── izumi/                # Nurse persona — expressions, motions, textures
    └── src/
        ├── App.jsx                   # Root layout, mobile detection, mode switching
        ├── components/
        │   ├── Avatar/
        │   │   ├── AvatarCanvas.jsx        # React ↔ Live2D bridge, WebGL mount
        │   │   ├── AvatarBackground.jsx    # Scene backgrounds
        │   │   ├── AvatarTransformPanel.jsx
        │   │   ├── ImageOverlay.jsx        # Contextual image display
        │   │   └── VoiceOrb.jsx            # Mic button, amplitude visualiser
        │   ├── Brand/
        │   │   └── PrxaNavbar.jsx          # VibeFlow AI navigation bar
        │   ├── Chat/
        │   │   ├── ChatPanel.jsx     # Chat UI, mode toggle, persona display
        │   │   ├── MessageList.jsx   # Scrollable history with emotion badges
        │   │   └── InputBox.jsx
        │   └── UI/
        │       ├── PersonaSelector.jsx
        │       ├── SettingsPanel.jsx
        │       └── MediaView.jsx     # Camera / screen-share overlay
        ├── hooks/
        │   ├── useChat.js              # SSE streaming, emotion/image tag parsing
        │   ├── useTextToSpeech.js      # Google TTS audio queue, amplitude
        │   ├── useSpeechRecognition.js # Continuous STT, silence timer
        │   ├── usePersona.js           # Persona state, system prompt resolution
        │   └── useAvatarTransform.js
        └── live2d/
            ├── AmplitudeProvider.ts    # Web Audio → Cubism lip sync bridge
            └── framework/              # Cubism TypeScript framework layer
```

---

## 🚀 Setup

### Prerequisites

- **Node.js 18+** and **npm 9+**
- (Optional) [Ollama](https://ollama.ai) for local, fully offline LLM inference
- (Optional) Anthropic or OpenAI API key for cloud LLM providers
- (Optional) Google Cloud TTS API key for Neural2 voices

### 1. Clone

```bash
git clone https://github.com/your-org/vibeflow-ai.git
cd vibeflow-ai
```

### 2. Backend

```bash
cd backend
cp .env.example .env
# Set LLM_PROVIDER and any API keys in .env
npm install
```

```bash
# Development (hot-reload)
npm run dev
# → http://localhost:3001

# Production
npm start
```

### 3. Frontend

```bash
cd ../frontend
npm install
npm run dev
# → http://localhost:5173
```

### 4. Local LLM via Ollama (optional)

For a fully offline, zero-cost pipeline:

```bash
# Install Ollama: https://ollama.ai/download
ollama pull llama3

# backend/.env
LLM_PROVIDER=ollama
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=llama3
```

### 5. Docker Compose (full stack)

```bash
cp backend/.env.example backend/.env
# Edit backend/.env with your API keys

docker compose up --build
# Backend → http://localhost:3001
# Frontend → http://localhost:5173
```

---

## ⚙️ Environment Variables

All keys are optional except those required by the selected `LLM_PROVIDER`.

```env
# ─── LLM Provider ──────────────────────────────────────────────────────────────
# Choose ONE: ollama | anthropic | openai
LLM_PROVIDER=ollama

# ─── Ollama (local, no API key required) ───────────────────────────────────────
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=llama3

# ─── Anthropic Claude ──────────────────────────────────────────────────────────
ANTHROPIC_API_KEY=your_anthropic_api_key_here
ANTHROPIC_MODEL=claude-sonnet-4-20250514
# Supported: claude-opus-4-20250514 | claude-sonnet-4-20250514 | claude-haiku-4-5-20251001

# ─── OpenAI GPT-4 ──────────────────────────────────────────────────────────────
OPENAI_API_KEY=your_openai_api_key_here
OPENAI_MODEL=gpt-4o
# Supported: gpt-4o | gpt-4-turbo | gpt-4o-mini

# ─── Google Cloud Text-to-Speech ───────────────────────────────────────────────
# Omit to automatically fall back to the browser Web Speech API
GOOGLE_TTS_API_KEY=your_google_tts_api_key_here

# ─── SerpApi (Google Images) ───────────────────────────────────────────────────
# Omit to fall back to deterministic Picsum placeholders
SERPAPI_KEY=your_serpapi_key_here

# ─── Server ────────────────────────────────────────────────────────────────────
PORT=3001

# ─── Avatar Persona Config (optional server-side override) ─────────────────────
# AVATAR_CONFIG_PATH=./avatar.config.json
```

---

## 🤖 LLM Provider Support

Switch providers by setting `LLM_PROVIDER` in `.env` — no code changes required.

| Provider | Streaming | Details |
|---|---|---|
| **Ollama** | NDJSON stream | Local inference · no API key · GPU-accelerated |
| **Anthropic Claude** | SSE `content_block_delta` | Requires `ANTHROPIC_API_KEY` |
| **OpenAI GPT-4** | SSE `choices[0].delta` | Requires `OPENAI_API_KEY` |

All providers receive an identical system prompt (persona definition + emotion tag instruction + image query instruction) and return streamed chunks to the same `onChunk` callback. Adding a new provider requires implementing one streaming method following the established interface.

---

## 💬 Usage

1. Open `http://localhost:5173` in **Chrome, Edge, or any Chromium-based browser**.
2. Select a persona from the **Persona Selector** — each card shows the character's name, role, and personality profile.
3. Click the **microphone orb** to begin listening, or type directly in the chat input.
4. Speak naturally. The platform waits 600 ms after your last word before sending.
5. The avatar responds in real time: text streams on-screen, the avatar lip-syncs and emotes, and TTS audio plays back as it is generated sentence-by-sentence.

**Layout modes** — use the toggle in the Chat Panel header:
- **Split screen** — avatar on the left, chat history on the right.
- **Full-screen avatar** — chat minimises; conversation subtitles appear as an overlay strip.

**Custom personas** — deploy a custom persona by configuring `avatar.config.json`:

```json
{
  "name": "Alex",
  "role": "Tech Support Specialist",
  "traits": "patient, clear, solution-oriented",
  "dialogueBehavior": "concise",
  "systemPrompt": "You are Alex, a friendly tech support specialist..."
}
```

Then set `AVATAR_CONFIG_PATH=./avatar.config.json` in your backend environment.

---

## ☁️ Deployment

The backend is fully stateless — each `/api/chat` request includes the complete conversation history from the client. This design enables:

- **Horizontal scaling** behind any load balancer
- **Zero-config deployment** to Railway, Fly.io, Render, AWS ECS, or GCP Cloud Run
- **Instant rollback** — no state migration required

---

## ⚠️ Known Limitations

- **Live2D model licences** — Bundled Haru, Haru Greeter, and Izumi models are sample assets from Live2D Inc. and are subject to the [Live2D Free Material License Agreement](https://www.live2d.com/en/terms/live2d-free-material-license-agreement/). Provided for development and demo purposes only.
- **Speech recognition browser support** — `webkitSpeechRecognition` requires Chrome, Edge, or Chromium-based browsers. Firefox and some iOS Safari versions do not support the Continuous Speech Recognition API.
- **Google TTS latency** — Cloud TTS adds ~200–600 ms per sentence round-trip. The Web Speech API fallback is synchronous but lower fidelity.

---

## 🗺 Roadmap

- [ ] Persistent session history and conversation export
- [ ] Additional bundled AI personas and domain configurations
- [ ] WebRTC-based audio streaming to reduce TTS latency
- [ ] Phoneme-accurate lip sync via Rhubarb (WASM) or Azure Viseme events
- [ ] Custom avatar import (`.model3.json` upload)
- [ ] Analytics dashboard for interaction performance metrics
- [ ] Multi-language support (30+ languages via Google Neural2)

---

## 📄 License

This project is licensed under the **MIT License** — see [LICENSE](LICENSE) for full terms.

> **Asset licence note:** Live2D model assets in `frontend/public/models/` are governed by the [Live2D Free Material License Agreement](https://www.live2d.com/en/terms/live2d-free-material-license-agreement/) and are not covered by the MIT licence above.

---

## 🎯 Elevator Pitch

VibeFlow AI bridges the gap between cold chatbot interfaces and genuine human connection. By combining large language models with real-time animated avatars, expressive emotion systems, and natural voice interaction, we deliver an AI experience that feels less like typing into a search box and more like talking to someone who understands you. Whether you're building training simulations, virtual companions, customer-facing agents, or interactive learning tools — VibeFlow AI is the conversational layer that makes AI feel alive.

---

## 💡 One-Line Tagline

**Talk Naturally. Experience AI.**

---

Built by **Team CodeWithMay** · HackIndia Conversation AI Hackathon 2026

*VibeFlow AI — Where every conversation flows.*
