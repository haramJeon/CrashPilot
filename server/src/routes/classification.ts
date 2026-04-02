import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { Server as SocketIOServer } from 'socket.io';
import { loadConfig } from '../services/config';
import { fetchAllNewReports, fetchSoftwares, fetchReportDetail } from '../services/crashReportServer';
import { classifyCrashes } from '../services/classifier';
import { isJiraConfigured } from '../services/jira';
import { runClaude } from '../services/claude';
import { loadHistory } from './pipeline';
import { downloadPdbFiles, downloadDump, analyzeDump, extractCallStack } from '../services/dump';
import { ClassificationRun, ClassificationResult, CrashReport } from '../types';
import { getDataRoot } from '../utils/appPaths';

const RUNS_DIR = path.join(getDataRoot(), 'data', 'classification-runs');

function ensureRunsDir() {
  if (!fs.existsSync(RUNS_DIR)) fs.mkdirSync(RUNS_DIR, { recursive: true });
}

function runFilePath(runId: string): string {
  return path.join(RUNS_DIR, `${runId}.json`);
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
    return fs.readdirSync(RUNS_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(RUNS_DIR, f), 'utf-8')) as ClassificationRun;
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

  // DELETE /api/classification/history/:runId
  router.delete('/history/:runId', (req, res) => {
    const file = runFilePath(req.params.runId);
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'Run not found' });
    fs.unlinkSync(file);
    res.status(204).end();
  });

  // DELETE /api/classification/history
  router.delete('/history', (_req, res) => {
    ensureRunsDir();
    fs.readdirSync(RUNS_DIR)
      .filter((f) => f.endsWith('.json'))
      .forEach((f) => fs.unlinkSync(path.join(RUNS_DIR, f)));
    res.status(204).end();
  });

  // GET /api/classification/status
  router.get('/status', (_req, res) => {
    const config = loadConfig();
    res.json({ jiraConfigured: isJiraConfigured(config) });
  });

  // GET /api/classification/preview
  // query: softwareId, startDate, endDate
  router.get('/preview', async (req, res) => {
    const { softwareId, startDate, endDate } = req.query as Record<string, string>;
    if (!softwareId || !startDate || !endDate) {
      return res.status(400).json({ error: 'softwareId, startDate, endDate 필수' });
    }
    try {
      const crashes = await fetchAllNewReports({ softwareId: Number(softwareId), startDate, endDate });
      res.json(crashes.map(({ id, subject, swVersion, receivedAt, exceptionCode, osType, issueKey, softwareName }) => ({
        id, subject, swVersion, receivedAt, exceptionCode, osType, issueKey, softwareName,
      })));
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? String(e) });
    }
  });

  // POST /api/classification/run
  // body: { softwareId: number, startDate: string, endDate: string, strict?: boolean }
  router.post('/run', async (req, res) => {
    const { softwareId, startDate, endDate, strict } = req.body;
    if (!softwareId || !startDate || !endDate) {
      return res.status(400).json({ error: 'softwareId, startDate, endDate 필수' });
    }

    const runId = `${softwareId}_${startDate}_${endDate}_${Date.now()}`;
    abortFlags.set(runId, false);

    // 소프트웨어 이름 조회 및 config에서 sprintId 읽기
    let softwareName: string | undefined;
    let sprintId: number | null | undefined;
    try {
      const softwares = await fetchSoftwares();
      const sw = softwares.find((s) => s.id === Number(softwareId));
      softwareName = sw?.name;
    } catch { /* ignore */ }
    const configForSprint = loadConfig();
    sprintId = configForSprint.jiraSprintIds?.[String(softwareId)] ?? null;

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
          Number(softwareId),
          strict === true,
          sprintId,
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

  // POST /api/classification/run-dump-and-analyze/:crashId
  // dump 분석(PDB+CDB/minidump) 실행 후 연속으로 Claude 분류 분석
  // body: CrashReport (dumpUrl 포함)
  router.post('/run-dump-and-analyze/:crashId', async (req, res) => {
    const crashId = Number(req.params.crashId);
    if (isNaN(crashId)) return res.status(400).json({ error: 'Invalid crashId' });

    const crash: CrashReport = req.body;
    const config = loadConfig();
    res.json({ ok: true });

    const emit = (event: string, data: any) =>
      io.emit(`classification:analysis:${event}`, { crashId, ...data });

    try {
      emit('log', { message: `크래시 #${crashId} 덤프 분석 시작...` });

      const detail = await fetchReportDetail(crashId);
      const osType = detail.osType ?? 'windows';
      const exceptionType = detail.exceptionCode || detail.bugcheck || 'Unknown Exception';

      // ── Dump 분석 ──────────────────────────────────────────────────────
      let cdbCallStack: string | null = null;
      let stackSource = 'API';

      try {
        emit('log', { message: 'PDB 파일 준비 중...' });
        const pdbDir = await downloadPdbFiles(
          detail.softwareId, detail.swVersion, osType,
          (line) => emit('log', { message: line }),
        );

        emit('log', { message: 'dump 분석 중...' });
        const dmpPath = await downloadDump(
          String(crashId), crash.dumpUrl, pdbDir,
          (line) => emit('log', { message: line }),
        );

        const dmpBase = path.basename(dmpPath, '.dmp');
        const cachedExt = osType === 'macos' ? '_minidump.txt' : '_cdb.txt';
        const cdbTxtPath = path.join(pdbDir, `${dmpBase}${cachedExt}`);

        let cdbOutput: string;
        if (fs.existsSync(cdbTxtPath)) {
          cdbOutput = fs.readFileSync(cdbTxtPath, 'utf-8');
          emit('log', { message: `캐시된 분석 결과 사용: ${path.basename(cdbTxtPath)}` });
        } else {
          cdbOutput = await analyzeDump(dmpPath, pdbDir, osType, (line) => emit('log', { message: line }));
        }

        const parsed = extractCallStack(cdbOutput, osType);
        if (parsed.callStack) {
          cdbCallStack = parsed.callStack;
          stackSource = osType === 'macos' ? 'minidump_stackwalk' : 'CDB';
        }
      } catch (dumpErr: any) {
        emit('log', { message: `덤프 분석 실패: ${dumpErr.message.split('\n')[0]} — API 스택으로 폴백` });
      }

      // ── 스택 결정 ────────────────────────────────────────────────────
      // CDB/minidump 결과 없으면 기존 pipeline history → API 스택 순으로 폴백
      if (!cdbCallStack || !cdbCallStack.trim() || cdbCallStack === '(no stack trace)') {
        const pipelineHistory = loadHistory(String(crashId));
        const historyCdb = pipelineHistory?.pipelineState?.cdbCallStack;
        if (historyCdb && historyCdb.trim() && historyCdb !== '(no stack trace)') {
          cdbCallStack = historyCdb;
          stackSource = 'Pipeline (이전 실행)';
        }
      }

      let fullStack: string;
      if (cdbCallStack && cdbCallStack.trim() && cdbCallStack !== '(no stack trace)') {
        fullStack = cdbCallStack;
      } else {
        const frames = detail.stackTraces.length > 0 ? detail.stackTraces : detail.mainStackTraces;
        fullStack = frames.length > 0
          ? frames
              .slice(0, 30)
              .map((f, i) => `  #${i} ${f.functionName ? `${f.dllName}!${f.functionName}` : f.dllName}`)
              .join('\n')
          : '(스택 없음)';
        stackSource = `API (${frames.length}프레임)`;
      }

      emit('log', { message: `스택 로드 완료 [출처: ${stackSource}]` });
      emit('log', { message: 'Claude 분석 시작...' });

      const prompt = `당신은 C++ 크래시 리포트를 분석하는 전문가입니다. 코드 수정은 하지 않고 근본 원인 분석만 수행합니다.

## 크래시 정보
- Subject: ${detail.subject}
- Exception Code: ${exceptionType}
- SW Version: ${detail.swVersion}
- OS: ${osType}

## Call Stack:
${fullStack}

## 분석 요청
1. 크래시가 발생한 핵심 함수/모듈을 식별하세요 (OS/런타임 프레임 제외)
2. 예외 코드와 스택 패턴을 기반으로 가능한 근본 원인을 설명하세요
3. 이 크래시의 버그 유형을 분류하세요 (null 참조, use-after-free, 스택 오버플로, race condition 등)
4. 코드를 수정하지 말고, 수정 방향에 대한 힌트만 제공하세요

## 예외 코드 참고
- 0xC0000005 (ACCESS_VIOLATION): ~0x0–0xFF 범위 = null 역참조; 큰 주소 = 댕글링 포인터
- 0xC00000FD (STACK_OVERFLOW): 스택에 재귀 패턴 탐색
- 0xC0000374 (heap corruption): 크래시 위치 ≠ 손상 위치 — 가장 이른 의심 프레임 탐색
- 0x40000015 (FATAL_APP_EXIT): std::terminate — 처리되지 않은 예외 또는 순수 가상 호출

## 출력 형식 (JSON만, 마크다운 없이)
{
  "crashLocation": "크래시 발생 핵심 함수/모듈",
  "bugType": "버그 유형 (한국어)",
  "rootCause": "근본 원인 설명 (한국어, 3-5문장)",
  "hints": "수정 방향 힌트 (한국어, 2-3문장, 코드 수정 없음)"
}`;

      const { promise } = runClaude(
        prompt,
        undefined,
        [],
        (line) => emit('log', { message: line }),
        undefined,
        config.claude.model,
      );

      const raw = await promise;

      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      let parsed: any;
      try {
        parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
      } catch {
        parsed = { crashLocation: '파싱 실패', bugType: 'unknown', rootCause: raw.slice(0, 500), hints: '' };
      }

      emit('complete', {
        crashLocation: parsed.crashLocation ?? '',
        bugType: parsed.bugType ?? '',
        rootCause: parsed.rootCause ?? '',
        hints: parsed.hints ?? '',
      });
    } catch (e: any) {
      emit('error', { message: e?.message ?? String(e) });
    }
  });

  // POST /api/classification/analyze-crash/:crashId
  // 스택 기반 분석 전용 (코드 수정 없음)
  router.post('/analyze-crash/:crashId', async (req, res) => {
    const crashId = Number(req.params.crashId);
    if (isNaN(crashId)) return res.status(400).json({ error: 'Invalid crashId' });

    const config = loadConfig();
    res.json({ ok: true });

    const emit = (event: string, data: any) =>
      io.emit(`classification:analysis:${event}`, { crashId, ...data });

    try {
      emit('log', { message: `크래시 #${crashId} 상세 정보 조회 중...` });

      const detail = await fetchReportDetail(crashId);

      // Pipeline CDB/minidump_stackwalk 결과 우선 사용, 없으면 API 스택 fallback
      const pipelineHistory = loadHistory(String(crashId));
      const cdbCallStack = pipelineHistory?.pipelineState?.cdbCallStack;

      let fullStack: string;
      let stackSource: string;
      if (cdbCallStack && cdbCallStack.trim() && cdbCallStack !== '(no stack trace)') {
        fullStack = cdbCallStack;
        stackSource = 'Pipeline (CDB/minidump_stackwalk)';
      } else {
        const frames = detail.stackTraces.length > 0 ? detail.stackTraces : detail.mainStackTraces;
        fullStack = frames.length > 0
          ? frames
              .slice(0, 30)
              .map((f, i) => `  #${i} ${f.functionName ? `${f.dllName}!${f.functionName}` : f.dllName}`)
              .join('\n')
          : '(스택 없음)';
        stackSource = `API (${frames.length}프레임)`;
      }

      emit('log', { message: `스택 로드 완료 [출처: ${stackSource}]` });
      emit('log', { message: 'Claude 분석 시작...' });

      const prompt = `당신은 C++ 크래시 리포트를 분석하는 전문가입니다. 코드 수정은 하지 않고 근본 원인 분석만 수행합니다.

## 크래시 정보
- Subject: ${detail.subject}
- Exception Code: ${detail.exceptionCode ?? 'unknown'}
- SW Version: ${detail.swVersion}
- OS: ${detail.osType ?? 'unknown'}

## Call Stack:
${fullStack}

## 분석 요청
1. 크래시가 발생한 핵심 함수/모듈을 식별하세요 (OS/런타임 프레임 제외)
2. 예외 코드와 스택 패턴을 기반으로 가능한 근본 원인을 설명하세요
3. 이 크래시의 버그 유형을 분류하세요 (null 참조, use-after-free, 스택 오버플로, race condition 등)
4. 코드를 수정하지 말고, 수정 방향에 대한 힌트만 제공하세요

## 예외 코드 참고
- 0xC0000005 (ACCESS_VIOLATION): ~0x0–0xFF 범위 = null 역참조; 큰 주소 = 댕글링 포인터
- 0xC00000FD (STACK_OVERFLOW): 스택에 재귀 패턴 탐색
- 0xC0000374 (heap corruption): 크래시 위치 ≠ 손상 위치 — 가장 이른 의심 프레임 탐색
- 0x40000015 (FATAL_APP_EXIT): std::terminate — 처리되지 않은 예외 또는 순수 가상 호출

## 출력 형식 (JSON만, 마크다운 없이)
{
  "crashLocation": "크래시 발생 핵심 함수/모듈",
  "bugType": "버그 유형 (한국어)",
  "rootCause": "근본 원인 설명 (한국어, 3-5문장)",
  "hints": "수정 방향 힌트 (한국어, 2-3문장, 코드 수정 없음)"
}`;

      const { promise } = runClaude(
        prompt,
        undefined,
        [],
        (line) => emit('log', { message: line }),
        undefined,
        config.claude.model,
      );

      const raw = await promise;

      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      let parsed: any;
      try {
        parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
      } catch {
        parsed = { crashLocation: '파싱 실패', bugType: 'unknown', rootCause: raw.slice(0, 500), hints: '' };
      }

      emit('complete', {
        crashLocation: parsed.crashLocation ?? '',
        bugType: parsed.bugType ?? '',
        rootCause: parsed.rootCause ?? '',
        hints: parsed.hints ?? '',
      });
    } catch (e: any) {
      emit('error', { message: e?.message ?? String(e) });
    }
  });

  return router;
}
