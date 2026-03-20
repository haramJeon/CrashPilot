import express from 'express';
import cors from 'cors';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { Server as SocketIOServer } from 'socket.io';
import dotenv from 'dotenv';
import { getAppRoot } from './utils/appPaths';
import { configRouter } from './routes/config';
import { gitRouter } from './routes/git';
import { crashRouter } from './routes/crash';
import { pipelineRouter } from './routes/pipeline';

dotenv.config();

// ── File logger (writes next to exe so errors are visible even without console) ──
const logPath = path.join(getAppRoot(), 'crashpilot.log');
function writeLog(level: string, ...args: any[]) {
  const line = `[${new Date().toISOString()}] [${level}] ${args.map(String).join(' ')}\n`;
  process.stdout.write(line);
  try { fs.appendFileSync(logPath, line); } catch { /* ignore if log write fails */ }
}

// Catch unhandled errors so the process doesn't silently die
process.on('uncaughtException', (err) => {
  writeLog('FATAL', 'uncaughtException:', err.stack || err.message);
});
process.on('unhandledRejection', (reason) => {
  writeLog('FATAL', 'unhandledRejection:', reason instanceof Error ? reason.stack : String(reason));
});

// Ensure data/ directory exists next to the executable (or project root in dev)
const dataDir = path.join(getAppRoot(), 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: '*' }
});

app.use(cors());
app.use(express.json());

// Serve React build in production
const clientDist = path.join(getAppRoot(), 'client/dist');
app.use(express.static(clientDist));

// API routes
app.use('/api/config', configRouter);
app.use('/api/git', gitRouter);
app.use('/api/crash', crashRouter(io));
app.use('/api/pipeline', pipelineRouter(io));

// SPA fallback
app.get('*', (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

// WebSocket
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  writeLog('INFO', `CrashPilot server running on ${url}`);
  // Auto-open browser (Windows only, ignore errors)
  exec(`start ${url}`, (err) => {
    if (err) writeLog('WARN', 'Could not open browser:', err.message);
  });
});

export { io };
