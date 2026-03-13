import { Router } from 'express';
import { Server as SocketIOServer } from 'socket.io';
import { fetchAllNewReports, fetchReportDetail } from '../services/crashReportServer';
import type { CrashReport } from '../types';

// In-memory store
let crashReports: CrashReport[] = [];

export function crashRouter(io: SocketIOServer): Router {
  const router = Router();

  // Fetch crash reports from crashReportOrganizer server
  router.post('/fetch', async (_req, res) => {
    try {
      io.emit('status', { message: 'Fetching crash reports from server...' });
      crashReports = await fetchAllNewReports();
      io.emit('crashes:updated', crashReports);
      res.json({ count: crashReports.length, crashes: crashReports });
    } catch (error: any) {
      io.emit('status', { message: `Error: ${error.message}`, type: 'error' });
      res.status(500).json({ error: error.message });
    }
  });

  // Get all cached reports
  router.get('/', (_req, res) => {
    res.json(crashReports);
  });

  // Get single report (fetch detail from API if needed)
  router.get('/:id', async (req, res) => {
    const id = Number(req.params.id);
    const cached = crashReports.find((c) => c.id === id);

    // If cached and already has stack traces, return as-is
    if (cached && cached.stackTraces.length > 0) {
      return res.json(cached);
    }

    // Fetch detail from API to get stack traces
    try {
      const detail = await fetchReportDetail(id);
      const idx = crashReports.findIndex((c) => c.id === id);
      if (idx >= 0) {
        crashReports[idx] = { ...crashReports[idx], ...detail };
        return res.json(crashReports[idx]);
      }
      return res.json(detail);
    } catch (e: any) {
      if (cached) return res.json(cached);
      return res.status(404).json({ error: 'Not found' });
    }
  });

  // Update crash status (internal use by pipeline)
  router.patch('/:id', (req, res) => {
    const id = Number(req.params.id);
    const idx = crashReports.findIndex((c) => c.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    crashReports[idx] = { ...crashReports[idx], ...req.body };
    io.emit('crashes:updated', crashReports);
    res.json(crashReports[idx]);
  });

  return router;
}
