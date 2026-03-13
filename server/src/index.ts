import express from 'express';
import cors from 'cors';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import dotenv from 'dotenv';
import path from 'path';
import { configRouter } from './routes/config';
import { gitRouter } from './routes/git';
import { crashRouter } from './routes/crash';
import { pipelineRouter } from './routes/pipeline';

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: '*' }
});

app.use(cors());
app.use(express.json());

// Serve React build in production
const clientDist = path.join(__dirname, '../../client/dist');
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
  console.log(`CrashPilot server running on http://localhost:${PORT}`);
});

export { io };
