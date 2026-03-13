import { Router } from 'express';
import { Server as SocketIOServer } from 'socket.io';
import { fetchCrashEmails } from '../services/outlook';
import { CrashEmail } from '../types';

// In-memory store
let crashEmails: CrashEmail[] = [];

export function crashRouter(io: SocketIOServer): Router {
  const router = Router();

  // Fetch crash emails from Outlook
  router.post('/fetch', async (_req, res) => {
    try {
      io.emit('status', { message: 'Fetching crash emails from Outlook...' });
      crashEmails = await fetchCrashEmails();
      io.emit('crashes:updated', crashEmails);
      res.json({ count: crashEmails.length, crashes: crashEmails });
    } catch (error: any) {
      io.emit('status', { message: `Error: ${error.message}`, type: 'error' });
      res.status(500).json({ error: error.message });
    }
  });

  // Get all cached crash emails
  router.get('/', (_req, res) => {
    res.json(crashEmails);
  });

  // Get single crash
  router.get('/:id', (req, res) => {
    const crash = crashEmails.find((c) => c.id === req.params.id);
    if (!crash) return res.status(404).json({ error: 'Not found' });
    res.json(crash);
  });

  // Update crash status (internal use)
  router.patch('/:id', (req, res) => {
    const idx = crashEmails.findIndex((c) => c.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    crashEmails[idx] = { ...crashEmails[idx], ...req.body };
    io.emit('crashes:updated', crashEmails);
    res.json(crashEmails[idx]);
  });

  return router;
}
