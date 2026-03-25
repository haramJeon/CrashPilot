import { Router } from 'express';
import { Server as SocketIOServer } from 'socket.io';
import { fetchAllNewReports, fetchReportDetail, fetchSoftwares } from '../services/crashReportServer';
import type { FetchFilter } from '../services/crashReportServer';
import type { CrashReport } from '../types';

// In-memory store
let crashReports: CrashReport[] = [];

// issueKey lookup: populated from list API so direct-navigation crash fetches can still show links
const issueKeyCache = new Map<number, string>();

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
      const [reports, softwares] = await Promise.all([
        fetchAllNewReports(filter),
        fetchSoftwares(),
      ]);
      const swMap = new Map(softwares.map((s) => [s.id, s.name]));
      crashReports = reports.map((r) => ({ ...r, softwareName: swMap.get(r.softwareId) }));
      // Populate issueKey cache so direct-navigation fetches can find it later
      crashReports.forEach((r) => { if (r.issueKey && r.issueKey !== 'None') issueKeyCache.set(r.id, r.issueKey); });
      io.emit('crashes:updated', crashReports);
      res.json({ count: crashReports.length, crashes: crashReports });

      // Background: populate osType by fetching details in parallel (5 at a time)
      const CONCURRENCY = 5;
      const snapshot = [...crashReports];
      for (let i = 0; i < snapshot.length; i += CONCURRENCY) {
        const batch = snapshot.slice(i, i + CONCURRENCY);
        await Promise.allSettled(
          batch.map(async (report) => {
            if (report.osType) return; // already known
            try {
              const detail = await fetchReportDetail(report.id);
              if (detail.osType) updateCrashRecord(report.id, { osType: detail.osType });
            } catch { /* ignore individual failures */ }
          })
        );
        io.emit('crashes:updated', crashReports);
      }
      io.emit('status', { message: `OS type resolved for ${snapshot.length} reports` });
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
      // Preserve issueKey: detail API may not return it, but list API (cache/issueKeyCache) has it
      const resolvedIssueKey = detail.issueKey || cached?.issueKey || issueKeyCache.get(id);
      if (resolvedIssueKey) detail.issueKey = resolvedIssueKey;
      const idx = crashReports.findIndex((c) => c.id === id);
      if (idx >= 0) {
        crashReports[idx] = { ...crashReports[idx], ...detail, issueKey: resolvedIssueKey || crashReports[idx].issueKey };
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
