import express from 'express';
import cors from 'cors';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { Server as SocketIOServer } from 'socket.io';
import dotenv from 'dotenv';
import { getAppRoot, getDataRoot } from './utils/appPaths';
import { configRouter } from './routes/config';
import { gitRouter } from './routes/git';
import { crashRouter } from './routes/crash';
import { pipelineRouter } from './routes/pipeline';
import { classificationRouter } from './routes/classification';
import { updateRouter } from './routes/update';

dotenv.config();

// ── File logger (writes next to exe so errors are visible even without console) ──
const logPath = path.join(getDataRoot(), 'crashpilot.log');
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

// Ensure data root and data/ subdirectory exist (ProgramData in production)
const dataRoot = getDataRoot();
if (!fs.existsSync(dataRoot)) fs.mkdirSync(dataRoot, { recursive: true });
const dataDir = path.join(dataRoot, 'data');
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
app.use('/api/classification', classificationRouter(io));
app.use('/api/update', updateRouter());

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
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    const url = `http://localhost:${PORT}`;
    writeLog('INFO', `Port ${PORT} already in use — CrashPilot is already running. Opening browser...`);
    const openCmd = process.platform === 'darwin' ? 'open' : 'start';
    exec(`${openCmd} ${url}`, () => {});
    process.exit(0);
  } else {
    writeLog('FATAL', 'Server error:', err.message);
    process.exit(1);
  }
});
server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  writeLog('INFO', `CrashPilot server running on ${url}`);
  const openCmd = process.platform === 'darwin' ? 'open' : 'start';
  exec(`${openCmd} ${url}`, (err) => {
    if (err) writeLog('WARN', 'Could not open browser:', err.message);
  });
});

export { io };
