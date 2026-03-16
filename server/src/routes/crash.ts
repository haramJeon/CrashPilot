import { Router } from 'express';
import { Server as SocketIOServer } from 'socket.io';
import { fetchAllNewReports, fetchReportDetail, fetchSoftwares } from '../services/crashReportServer';
import type { FetchFilter } from '../services/crashReportServer';
import type { CrashReport } from '../types';

// In-memory store
let crashReports: CrashReport[] = [];

export function updateCrashRecord(id: number, updates: Partial<CrashReport>): void {
  const idx = crashReports.findIndex((c) => c.id === id);
  if (idx >= 0) crashReports[idx] = { ...crashReports[idx], ...updates };
}

export function getCrashRecord(id: number): CrashReport | undefined {
  return crashReports.find((c) => c.id === id);
}

export function crashRouter(io: SocketIOServer): Router {
  const router = Router();

  // Get software list for Dashboard filter
  router.get('/softwares', async (_req, res) => {
    try {
      const list = await fetchSoftwares();
      res.json(list);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Fetch crash reports with optional filters
  router.post('/fetch', async (req, res) => {
    const filter: FetchFilter = {
      softwareId: req.body?.softwareId ? Number(req.body.softwareId) : undefined,
      startDate: req.body?.startDate || undefined,
      endDate: req.body?.endDate || undefined,
    };
    try {
      io.emit('status', { message: 'Fetching crash reports from server...' });
      crashReports = await fetchAllNewReports(filter);
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
