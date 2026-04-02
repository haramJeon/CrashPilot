import { Router } from 'express';
import { loadConfig } from '../services/config';
import {
  CURRENT_VERSION,
  UpdateInfo,
  checkForUpdates,
} from '../services/updater';

let cachedInfo: UpdateInfo | null = null;

export function updateRouter(): Router {
  const router = Router();

  // GET /api/update/check
  router.get('/check', async (_req, res) => {
    const config = loadConfig();
    if (!config.autoUpdate?.githubRepo || config.autoUpdate.enabled === false) {
      return res.json({
        hasUpdate: false,
        currentVersion: CURRENT_VERSION,
        latestVersion: CURRENT_VERSION,
      });
    }

    try {
      const info = await checkForUpdates(config.autoUpdate.githubRepo, config.autoUpdate.githubToken);
      cachedInfo = info;
      res.json(info);
    } catch (e: any) {
      res.json({
        hasUpdate: false,
        currentVersion: CURRENT_VERSION,
        latestVersion: CURRENT_VERSION,
        error: e?.message ?? String(e),
      });
    }
  });

  return router;
}
