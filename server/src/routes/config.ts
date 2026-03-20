import { Router } from 'express';
import { loadConfig, saveConfig, getCurrentPlatform } from '../services/config';
import { fetchSoftwares } from '../services/crashReportServer';

export const configRouter = Router();

const MASK = '••••••••';

configRouter.get('/', (_req, res) => {
  const config = loadConfig();
  const masked = {
    ...config,
    claude: {
      ...config.claude,
      apiKey: config.claude.apiKey ? MASK : '',
    },
    github: {
      ...config.github,
      token: config.github.token ? MASK : '',
    },
  };
  res.json(masked);
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

  if (incoming.claude?.apiKey === MASK)      incoming.claude.apiKey      = current.claude.apiKey;
  if (incoming.github?.token === MASK)       incoming.github.token       = current.github.token;

  const merged = { ...current, ...incoming };
  saveConfig(merged);
  res.json({ success: true });
});

configRouter.get('/validate', (_req, res) => {
  const config = loadConfig();
  const platform = getCurrentPlatform();
  const issues: string[] = [];

  if (!config.crashReportServer.url) issues.push('Crash Report Server URL is missing');
  if (!config.claude.apiKey) issues.push('Claude API Key is missing');
  if (!config.git.repoBaseDir) issues.push('Git Clone Base Directory is missing');
  if (!config.git.repoUrl) issues.push('Git Repository URL is missing');
  if (!config.github.token) issues.push('GitHub Token is missing');

  if (platform === 'windows') {
    if (!config.debugger.windows.cdbPath) issues.push('CDB Path is missing');
  } else {
    if (!config.debugger.macos.lldbPath) issues.push('lldb Path is missing');
  }

  res.json({ valid: issues.length === 0, issues });
});
