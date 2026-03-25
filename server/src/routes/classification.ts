import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { Server as SocketIOServer } from 'socket.io';
import { loadConfig } from '../services/config';
import { fetchAllNewReports, fetchSoftwares } from '../services/crashReportServer';
import { classifyCrashes } from '../services/classifier';
import { isJiraConfigured } from '../services/jira';
import { ClassificationRun, ClassificationResult } from '../types';
import { getDataRoot } from '../utils/appPaths';

const RUNS_DIR = () => path.join(getDataRoot(), 'data', 'classification-runs');

function ensureRunsDir() {
  const dir = RUNS_DIR();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function runFilePath(runId: string): string {
  return path.join(RUNS_DIR(), `${runId}.json`);
}

function saveRun(run: ClassificationRun) {
  ensureRunsDir();
  fs.writeFileSync(runFilePath(run.id), JSON.stringify(run, null, 2), 'utf-8');
}

function loadRun(runId: string): ClassificationRun | null {
  try {
    const p = runFilePath(runId);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

function listRuns(): ClassificationRun[] {
  ensureRunsDir();
  try {
    return fs.readdirSync(RUNS_DIR())
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(RUNS_DIR(), f), 'utf-8')) as ClassificationRun;
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => new Date(b!.runAt).getTime() - new Date(a!.runAt).getTime()) as ClassificationRun[];
  } catch {
    return [];
  }
}

// 실행 중인 classification 취소 플래그
const abortFlags = new Map<string, boolean>();

export function classificationRouter(io: SocketIOServer): Router {
  const router = Router();

  // GET /api/classification/history
  router.get('/history', (_req, res) => {
    const runs = listRuns().map(({ id, runAt, softwareId, softwareName, startDate, endDate, totalCrashes, processedCrashes, status, errorMessage }) => ({
      id, runAt, softwareId, softwareName, startDate, endDate, totalCrashes, processedCrashes, status, errorMessage,
    }));
    res.json(runs);
  });

  // GET /api/classification/results/:runId
  router.get('/results/:runId', (req, res) => {
    const run = loadRun(req.params.runId);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    res.json(run);
  });

  // GET /api/classification/status
  router.get('/status', (_req, res) => {
    const config = loadConfig();
    res.json({ jiraConfigured: isJiraConfigured(config) });
  });

  // POST /api/classification/run
  // body: { softwareId: number, startDate: string, endDate: string }
  router.post('/run', async (req, res) => {
    const { softwareId, startDate, endDate } = req.body;
    if (!softwareId || !startDate || !endDate) {
      return res.status(400).json({ error: 'softwareId, startDate, endDate 필수' });
    }

    const runId = `${softwareId}_${startDate}_${endDate}_${Date.now()}`;
    abortFlags.set(runId, false);

    // 소프트웨어 이름 조회
    let softwareName: string | undefined;
    try {
      const softwares = await fetchSoftwares();
      softwareName = softwares.find((s) => s.id === Number(softwareId))?.name;
    } catch { /* ignore */ }

    const run: ClassificationRun = {
      id: runId,
      runAt: new Date().toISOString(),
      softwareId: Number(softwareId),
      softwareName,
      startDate,
      endDate,
      totalCrashes: 0,
      processedCrashes: 0,
      results: [],
      status: 'running',
    };
    saveRun(run);

    // 즉시 runId 반환
    res.json({ runId });

    // 비동기로 분류 실행
    (async () => {
      const config = loadConfig();
      const emit = (event: string, data: any) => io.emit(`classification:${event}`, { runId, ...data });

      try {
        emit('log', { message: `크래시 목록 조회 중... (${startDate} ~ ${endDate})` });
        const crashes = await fetchAllNewReports({ softwareId: Number(softwareId), startDate, endDate });
        run.totalCrashes = crashes.length;
        saveRun(run);

        emit('log', { message: `크래시 ${crashes.length}개 로드 완료` });

        if (crashes.length === 0) {
          run.status = 'completed';
          run.processedCrashes = 0;
          saveRun(run);
          emit('complete', { results: [], totalCrashes: 0 });
          return;
        }

        const results: ClassificationResult[] = await classifyCrashes(
          crashes,
          config,
          (progress) => {
            run.processedCrashes = progress.current;
            saveRun(run);
            emit('progress', { current: progress.current, total: progress.total, message: progress.message });
          },
          (line) => emit('log', { message: line }),
          () => abortFlags.get(runId) === true,
        );

        run.results = results;
        run.processedCrashes = results.length;
        run.status = 'completed';
        saveRun(run);

        emit('complete', { results, totalCrashes: crashes.length });
      } catch (e: any) {
        run.status = 'error';
        run.errorMessage = e?.message ?? String(e);
        saveRun(run);
        emit('error', { message: run.errorMessage });
      } finally {
        abortFlags.delete(runId);
      }
    })();
  });

  // POST /api/classification/cancel/:runId
  router.post('/cancel/:runId', (req, res) => {
    const { runId } = req.params;
    if (abortFlags.has(runId)) {
      abortFlags.set(runId, true);
      res.json({ ok: true });
    } else {
      res.status(404).json({ error: 'Run not found or already finished' });
    }
  });

  return router;
}
