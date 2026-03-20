import { Router } from 'express';
import { loadConfig, saveConfig, getCurrentPlatform } from '../services/config';
import { fetchSoftwares } from '../services/crashReportServer';

export const configRouter = Router();

configRouter.get('/', (_req, res) => {
  res.json(loadConfig());
});

configRouter.get('/platform', (_req, res) => {
  res.json({ platform: getCurrentPlatform() });
});

// Available softwares from crashReportOrganizer for UI selection
configRouter.get('/softwares', async (_req, res) => {
  try {
    const softwares = await fetchSoftwares();
    res.json(softwares);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

configRouter.post('/', (req, res) => {
  const current = loadConfig();
  const incoming = req.body;

  const merged = { ...current, ...incoming };
  saveConfig(merged);
  res.json({ success: true });
});

configRouter.get('/validate', (_req, res) => {
  const config = loadConfig();
  const platform = getCurrentPlatform();
  const issues: string[] = [];

  if (!config.crashReportServer.url) issues.push('Crash Report Server URL is missing');
  if (!config.git.repoBaseDir) issues.push('Git Clone Base Directory is missing');
  if (!config.git.repoUrl) issues.push('Git Repository URL is missing');

  if (platform === 'windows') {
    if (!config.debugger.windows.cdbPath) issues.push('CDB Path is missing');
  } else {
    if (!config.debugger.macos.lldbPath) issues.push('lldb Path is missing');
  }

  res.json({ valid: issues.length === 0, issues });
});
