import { Router } from 'express';
import { loadConfig, saveConfig, getCurrentPlatform } from '../services/config';

export const configRouter = Router();

configRouter.get('/', (_req, res) => {
  const config = loadConfig();
  const masked = {
    ...config,
    claude: {
      apiKey: config.claude.apiKey ? '••••••••' : '',
    },
    github: {
      ...config.github,
      token: config.github.token ? '••••••••' : '',
    },
  };
  res.json(masked);
});

configRouter.get('/platform', (_req, res) => {
  res.json({ platform: getCurrentPlatform() });
});

configRouter.post('/', (req, res) => {
  const current = loadConfig();
  const incoming = req.body;

  if (incoming.claude?.apiKey === '••••••••') {
    incoming.claude.apiKey = current.claude.apiKey;
  }
  if (incoming.github?.token === '••••••••') {
    incoming.github.token = current.github.token;
  }

  const merged = { ...current, ...incoming };
  saveConfig(merged);
  res.json({ success: true });
});

configRouter.get('/validate', (_req, res) => {
  const config = loadConfig();
  const platform = getCurrentPlatform();
  const issues: string[] = [];

  if (!config.outlook.clientId) issues.push('Outlook Client ID is missing');
  if (!config.outlook.tenantId) issues.push('Outlook Tenant ID is missing');
  if (!config.claude.apiKey) issues.push('Claude API Key is missing');
  if (!config.github.token) issues.push('GitHub Token is missing');
  if (!config.github.owner) issues.push('GitHub Owner is missing');
  if (!config.github.repo) issues.push('GitHub Repo is missing');

  if (platform === 'windows') {
    if (!config.debugger.windows.cdbPath) issues.push('CDB Path is missing');
  } else {
    if (!config.debugger.macos.lldbPath) issues.push('lldb Path is missing');
  }

  res.json({ valid: issues.length === 0, issues });
});
