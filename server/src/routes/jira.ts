import { Router } from 'express';
import { loadConfig } from '../services/config';
import { fetchOpenIssues, isJiraConfigured } from '../services/jira';

export function jiraRouter(): Router {
  const router = Router();

  router.get('/sprint-issues', async (req, res) => {
    const softwareId = req.query.softwareId as string | undefined;
    if (!softwareId) {
      return res.status(400).json({ error: 'softwareId is required' });
    }

    const config = loadConfig();

    if (!isJiraConfigured(config)) {
      return res.status(400).json({ error: 'Jira가 설정되지 않았습니다. Settings에서 Jira 정보를 입력하세요.' });
    }

    const sprintId = config.jiraSprintIds?.[softwareId] ?? null;

    try {
      const issues = await fetchOpenIssues(config, [], sprintId);
      res.json({ sprintId, issues });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}
