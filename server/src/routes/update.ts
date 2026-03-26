import { Router } from 'express';
import { Server as SocketIOServer } from 'socket.io';
import { loadConfig } from '../services/config';
import {
  CURRENT_VERSION,
  UpdateInfo,
  checkForUpdates,
  downloadUpdate,
  stageUpdate,
  applyUpdate,
} from '../services/updater';

type UpdateState = 'idle' | 'downloading' | 'staging' | 'ready' | 'applying' | 'error';

let cachedInfo: UpdateInfo | null = null;
let updateState: UpdateState = 'idle';
let stateMessage = '';

export function updateRouter(io: SocketIOServer): Router {
  const router = Router();

  function broadcast(event: string, data?: any) {
    io.emit(`update:${event}`, data ?? {});
  }

  // GET /api/update/check
  // Returns cached or fresh update info.
  router.get('/check', async (_req, res) => {
    const config = loadConfig();
    if (!config.autoUpdate?.githubRepo) {
      return res.json({
        hasUpdate: false,
        currentVersion: CURRENT_VERSION,
        latestVersion: CURRENT_VERSION,
        updateState,
        checkedAt: cachedInfo?.checkedAt,
      });
    }

    try {
      const info = await checkForUpdates(config.autoUpdate.githubRepo, config.autoUpdate.githubToken);
      cachedInfo = info;
      res.json({ ...info, updateState });
    } catch (e: any) {
      res.json({
        hasUpdate: false,
        currentVersion: CURRENT_VERSION,
        latestVersion: CURRENT_VERSION,
        updateState,
        error: e?.message ?? String(e),
      });
    }
  });

  // POST /api/update/download
  // Starts the download + staging pipeline in the background.
  router.post('/download', async (_req, res) => {
    if (updateState !== 'idle' && updateState !== 'error') {
      return res.status(409).json({ error: `Cannot start download in state: ${updateState}` });
    }
    const config = loadConfig();
    if (!cachedInfo?.hasUpdate || !cachedInfo.downloadUrl) {
      return res.status(400).json({ error: 'No update available — call /check first' });
    }

    res.json({ ok: true });

    updateState = 'downloading';
    stateMessage = '다운로드 중...';
    broadcast('state', { state: updateState, message: stateMessage });

    try {
      const zipPath = await downloadUpdate(
        cachedInfo.downloadUrl,
        config.autoUpdate?.githubToken,
        (bytesDownloaded, totalBytes) => {
          const percent = totalBytes > 0 ? Math.round((bytesDownloaded / totalBytes) * 100) : 0;
          broadcast('progress', { bytesDownloaded, totalBytes, percent });
        },
      );

      updateState = 'staging';
      stateMessage = '업데이트 준비 중...';
      broadcast('state', { state: updateState, message: stateMessage });

      await stageUpdate(zipPath, cachedInfo.latestVersion);

      updateState = 'ready';
      stateMessage = `v${cachedInfo.latestVersion} 설치 준비 완료`;
      broadcast('state', { state: updateState, message: stateMessage, latestVersion: cachedInfo.latestVersion });
    } catch (e: any) {
      updateState = 'error';
      stateMessage = e?.message ?? String(e);
      broadcast('state', { state: 'error', message: stateMessage });
    }
  });

  // POST /api/update/apply
  // Spawn the update script and exit.
  router.post('/apply', (_req, res) => {
    if (updateState !== 'ready') {
      return res.status(400).json({ error: `Cannot apply update in state: ${updateState}` });
    }
    updateState = 'applying';
    broadcast('state', { state: 'applying', message: '재시작 중...' });
    res.json({ ok: true });

    try {
      applyUpdate(); // spawns script + schedules process.exit
    } catch (e: any) {
      updateState = 'error';
      stateMessage = e?.message ?? String(e);
      broadcast('state', { state: 'error', message: stateMessage });
    }
  });

  return router;
}
