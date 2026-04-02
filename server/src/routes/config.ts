import { Router } from 'express';
import { loadConfig, saveConfig, getCurrentPlatform } from '../services/config';
import { fetchSoftwares } from '../services/crashReportServer';
import { fetchJiraIssue, isJiraConfigured } from '../services/jira';

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

// POST /api/config/jira-test
// body: { url, email, apiToken } — 저장 전 현재 폼 값으로 연결 테스트
configRouter.post('/jira-test', async (req, res) => {
  const { url, email, apiToken } = req.body ?? {};
  if (!url || !email || !apiToken) {
    return res.status(400).json({ ok: false, error: 'url, email, apiToken을 모두 입력하세요.' });
  }
  try {
    const baseUrl = String(url).replace(/\/$/, '');
    const auth = 'Basic ' + Buffer.from(`${email}:${apiToken}`).toString('base64');
    const r = await fetch(`${baseUrl}/rest/api/3/myself`, {
      headers: { Authorization: auth, Accept: 'application/json' },
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      return res.json({ ok: false, error: `Jira API error ${r.status}: ${body.slice(0, 200)}` });
    }
    const data = await r.json() as { displayName?: string; emailAddress?: string };
    res.json({ ok: true, displayName: data.displayName, email: data.emailAddress });
  } catch (e: any) {
    res.json({ ok: false, error: e.message });
  }
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
