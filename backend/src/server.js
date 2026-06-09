import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import chatRouter, { handleWebSocket } from './routes/chat.js';

dotenv.config();

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:5173', credentials: true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use((req, res, next) => { console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`); next(); });

app.use('/api', chatRouter);
app.get('/', (_, res) => res.json({ message:'AI Avatar Assistant API', version:'2.0.0', transport:'websocket+sse' }));
app.use((error, req, res, next) => { console.error('Server error:', error); res.status(500).json({ error:'Internal server error', message:error.message }); });

// Share one HTTP server between Express and WebSocket
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws/chat' });

wss.on('connection', (ws, req) => {
  console.log('[WS] client connected from', req.socket.remoteAddress);
  ws.on('message', (raw) => {
    let payload;
    try { payload = JSON.parse(raw); }
    catch { ws.send(JSON.stringify({ type:'error', message:'Invalid JSON' })); return; }
    // Run pipeline concurrently — each message is one independent request
    handleWebSocket(ws, payload).catch((err) => console.error('[WS] pipeline error:', err.message));
  });
  ws.on('close', () => console.log('[WS] client disconnected'));
  ws.on('error', (err) => console.error('[WS] socket error:', err.message));
});

httpServer.listen(PORT, () => {
  const provider = (process.env.LLM_PROVIDER || 'ollama').toLowerCase();
  const modelMap = { anthropic: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',
                     openai:    process.env.OPENAI_MODEL    || 'gpt-4o',
                     ollama:    process.env.OLLAMA_MODEL    || 'llama3' };
  const model   = modelMap[provider] || modelMap.ollama;
  const hasGroq = !!(process.env.GROQ_API_KEY && process.env.GROQ_API_KEY !== 'your_groq_api_key_here');
  const ttsMode = hasGroq ? 'groq-orpheus (~100ms)' : 'google-neural2 (~300ms)';
  console.log(`
╔════════════════════════════════════════════╗
║   AI Avatar Assistant - Backend Server    ║
╠════════════════════════════════════════════╣
║  Status:    Running on port ${PORT}           ║
║  Transport: WebSocket (/ws/chat) + SSE    ║
║  LLM:       ${provider} / ${model}
║  TTS:       ${ttsMode}
╚════════════════════════════════════════════╝
  `);
});

export default app;
