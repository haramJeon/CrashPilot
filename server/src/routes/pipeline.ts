import fs from 'fs';
import path from 'path';
import { Router } from 'express';
import { Server as SocketIOServer } from 'socket.io';
import { fetchReportDetail, formatCallStack } from '../services/crashReportServer';
import { analyzeAndFix } from '../services/claude';
import { downloadPdbFiles, downloadDump, analyzeDump, extractCallStack } from '../services/dump';
import { checkoutBranch, createFixBranch, applyFixes, commitAndPush, getSourceFiles, initSubmodules, getRepoDirForBranch } from '../services/git';
import { createPullRequest } from '../services/github';
import { updateCrashRecord } from './crash';
import type { CrashReport, CrashAnalysis, PipelineStep, PipelineRunHistory } from '../types';

const HISTORY_DIR = path.join(__dirname, '../../../data/pipeline-runs');

function saveHistory(history: PipelineRunHistory): void {
  if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });
  fs.writeFileSync(path.join(HISTORY_DIR, `${history.crashId}.json`), JSON.stringify(history, null, 2), 'utf-8');
}

function loadHistory(crashId: string): PipelineRunHistory | null {
  const file = path.join(HISTORY_DIR, `${crashId}.json`);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return null; }
}

function listHistoryIds(): number[] {
  if (!fs.existsSync(HISTORY_DIR)) return [];
  return fs.readdirSync(HISTORY_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => Number(f.replace('.json', '')))
    .filter((n) => !isNaN(n));
}

// Track cancellation flags per crashId
const cancelFlags = new Map<string, boolean>();

export function pipelineRouter(io: SocketIOServer): Router {
  const router = Router();

  router.get('/history', (_req, res) => {
    res.json(listHistoryIds());
  });

  router.get('/history/:crashId', (req, res) => {
    const history = loadHistory(req.params.crashId);
    if (!history) return res.status(404).json({ error: 'No history found' });
    res.json(history);
  });

  function emitSteps(crashId: string, steps: PipelineStep[]) {
    io.emit('pipeline:steps', { crashId, steps });
    updateCrashRecord(Number(crashId), { pipelineSteps: [...steps] });
  }

  router.post('/cancel/:crashId', (req, res) => {
    const crashId = req.params.crashId;
    if (cancelFlags.has(crashId)) {
      cancelFlags.set(crashId, true);
      res.json({ message: 'Cancel requested' });
    } else {
      res.status(404).json({ error: 'No running pipeline for this crash' });
    }
  });

  router.post('/run/:crashId', async (req, res) => {
    const crashId = req.params.crashId;
    const crash: CrashReport = req.body;

    cancelFlags.set(crashId, false);
    const isCancelled = () => cancelFlags.get(crashId) === true;

    const steps: PipelineStep[] = [
      { name: 'Load Stack Trace', status: 'pending' },   // 0
      { name: 'Download PDB Files', status: 'pending' }, // 1
      { name: 'Download Dump', status: 'pending' },      // 2
      { name: 'Analyze Dump (CDB)', status: 'pending' }, // 3
      { name: 'Clone / Pull', status: 'pending' },       // 4
      { name: 'Init Submodule', status: 'pending' },     // 5
      { name: 'AI Analysis & Fix', status: 'pending' },  // 6
      { name: 'Apply Fix & Commit', status: 'pending' }, // 7
      { name: 'Create PR', status: 'pending' },          // 8
    ];

    res.json({ message: 'Pipeline started', crashId });

    // Append a log line to a step and emit
    const log = (stepIdx: number, line: string) => {
      if (!steps[stepIdx].logs) steps[stepIdx].logs = [];
      steps[stepIdx].logs!.push(line);
      emitSteps(crashId, steps);
    };

    const throwIfCancelled = () => {
      if (isCancelled()) throw new Error('__CANCELLED__');
    };

    let releaseBranch = crash.releaseTag || loadHistory(crashId)?.releaseTag || '';

    try {
      // Step 1: Load stack trace
      steps[0].status = 'running';
      emitSteps(crashId, steps);

      const detail = await fetchReportDetail(crash.id);
      const callStack = formatCallStack(detail);
      const exceptionType = detail.exceptionCode || detail.bugcheck || 'Unknown Exception';
      releaseBranch = releaseBranch || detail.releaseTag || '';
      if (!releaseBranch) throw new Error('releaseTag is not set. Please set it from the Dashboard before running.');
      updateCrashRecord(Number(crashId), { releaseTag: releaseBranch });

      steps[0].status = 'done';
      steps[0].message = `${detail.stackTraces.length + detail.mainStackTraces.length} frames - ${exceptionType}`;
      emitSteps(crashId, steps);
      throwIfCancelled();

      // Step 2: Download PDB files (extract release build from network share)
      steps[1].status = 'running';
      emitSteps(crashId, steps);
      const pdbDir = await downloadPdbFiles(detail.softwareId, detail.swVersion, (line) => log(1, line));
      steps[1].status = 'done';
      steps[1].message = pdbDir;
      emitSteps(crashId, steps);
      throwIfCancelled();

      // Step 3: Download crash dump from DB file_link into PDB folder
      steps[2].status = 'running';
      emitSteps(crashId, steps);
      const dmpPath = await downloadDump(crashId, crash.dumpUrl, pdbDir, (line) => log(2, line));
      steps[2].status = 'done';
      steps[2].message = dmpPath;
      emitSteps(crashId, steps);
      throwIfCancelled();

      // Step 4: Analyze dump with CDB
      steps[3].status = 'running';
      emitSteps(crashId, steps);
      let cdbCallStack = callStack;        // fallback: use API stack trace
      let cdbExceptionType = exceptionType;
      let cdbFaultingModule = detail.stackTraces[0]?.dllName || 'Unknown';
      let cdbOutput = '';
      try {
        cdbOutput = await analyzeDump(dmpPath, pdbDir, (line) => log(3, line));
        const parsed = extractCallStack(cdbOutput);
        if (parsed.callStack) {
          cdbCallStack = parsed.callStack;
          cdbFaultingModule = parsed.faultingModule || cdbFaultingModule;
          if (parsed.exceptionType && parsed.exceptionType !== 'Unknown') {
            cdbExceptionType = parsed.exceptionType;
          }
        }
        steps[3].status = 'done';
        steps[3].message = `CDB analysis complete — ${cdbOutput.split('\n').length} lines`;
      } catch (cdbErr: any) {
        // CDB 실패 시 경고만 표시하고 계속 진행 (API 스택 트레이스로 fallback)
        steps[3].status = 'done';
        steps[3].message = `CDB skipped: ${cdbErr.message.split('\n')[0]}`;
        log(3, `Warning: CDB failed — ${cdbErr.message}`);
        log(3, 'Falling back to API stack trace for AI analysis');
      }
      emitSteps(crashId, steps);
      throwIfCancelled();

      // Step 5: Clone or pull (skip if already cloned)
      const repoDir = getRepoDirForBranch(releaseBranch);
      const alreadyCloned = fs.existsSync(path.join(repoDir, '.git'));

      if (alreadyCloned) {
        steps[4].status = 'done';
        steps[4].message = `Already cloned: ${repoDir}`;
        log(4, `Skipped — repo already exists at ${repoDir}`);
        emitSteps(crashId, steps);
      } else {
        steps[4].status = 'running';
        emitSteps(crashId, steps);
        await checkoutBranch(releaseBranch, (line) => log(4, line));
        steps[4].status = 'done';
        steps[4].message = `${releaseBranch} → ${repoDir}`;
        emitSteps(crashId, steps);
      }
      throwIfCancelled();

      // Step 6: Init submodules (skip if no .gitmodules or already initialized)
      const gitmodulesPath = path.join(repoDir, '.gitmodules');
      const modulesDir = path.join(repoDir, '.git', 'modules');
      const hasSubmodules = fs.existsSync(gitmodulesPath);
      const alreadyInit = hasSubmodules && fs.existsSync(modulesDir) && fs.readdirSync(modulesDir).length > 0;

      if (!hasSubmodules || alreadyInit) {
        steps[5].status = 'done';
        steps[5].message = hasSubmodules ? 'Already initialized' : 'No submodules';
        log(5, hasSubmodules ? 'Skipped — submodules already initialized' : 'Skipped — no submodules in repo');
        emitSteps(crashId, steps);
      } else {
        steps[5].status = 'running';
        emitSteps(crashId, steps);
        await initSubmodules(repoDir, (line) => log(5, line));
        steps[5].status = 'done';
        steps[5].message = 'git submodule update --init done';
        emitSteps(crashId, steps);
      }
      throwIfCancelled();

      // Step 7: Claude AI analysis (uses CDB output if available)
      steps[6].status = 'running';
      emitSteps(crashId, steps);

      const dllNames = detail.stackTraces
        .map((s) => s.dllName)
        .filter(Boolean)
        .filter((name) => !name.startsWith('ntdll') && !name.startsWith('kernel'));
      const uniqueDlls = [...new Set(dllNames)];
      const sourceFiles = await getSourceFiles(repoDir, uniqueDlls);

      const aiResult = await analyzeAndFix({
        callStack: cdbCallStack,
        exceptionType: cdbExceptionType,
        exceptionMessage: cdbOutput
          ? `[CDB Analysis]\n${cdbOutput.slice(0, 8000)}`
          : `Exception: ${cdbExceptionType}\nVersion: ${detail.swVersion}\nRegion: ${detail.region || 'N/A'}`,
        faultingModule: cdbFaultingModule,
        sourceFiles,
      });

      steps[6].status = 'done';
      steps[6].message = `Root cause identified - ${aiResult.fixedFiles.length} file(s) to fix`;
      emitSteps(crashId, steps);
      throwIfCancelled();

      // Step 8: Apply fix & commit
      steps[7].status = 'running';
      emitSteps(crashId, steps);

      const { branchName: fixBranch } = await createFixBranch(releaseBranch, String(crash.id), (line) => log(7, line));
      await applyFixes(repoDir, aiResult.fixedFiles, (line) => log(7, line));
      await commitAndPush(
        repoDir,
        aiResult.fixedFiles,
        `[CrashPilot] Fix ${cdbExceptionType} in ${cdbFaultingModule}\n\nReport #${crash.id} - v${detail.swVersion}\n\n${aiResult.suggestedFix}`,
        (line) => log(7, line)
      );

      steps[7].status = 'done';
      steps[7].message = `Pushed to ${fixBranch}`;
      emitSteps(crashId, steps);

      // Step 9: Create PR
      steps[8].status = 'running';
      emitSteps(crashId, steps);

      const analysis: CrashAnalysis = {
        callStack: cdbCallStack,
        exceptionType: cdbExceptionType,
        rootCause: aiResult.rootCause,
        suggestedFix: aiResult.suggestedFix,
        fixedFiles: aiResult.fixedFiles,
      };

      const prUrl = await createPullRequest({
        branch: fixBranch,
        baseBranch: releaseBranch,
        crashSubject: detail.subject,
        analysis,
      });

      analysis.prUrl = prUrl;
      steps[8].status = 'done';
      steps[8].message = prUrl;
      emitSteps(crashId, steps);

      saveHistory({ crashId, runAt: new Date().toISOString(), status: 'completed', releaseTag: releaseBranch, steps: [...steps], analysis });
      io.emit('pipeline:complete', { crashId, analysis });
    } catch (error: any) {
      const runningIdx = steps.findIndex((s) => s.status === 'running');
      if (error.message === '__CANCELLED__') {
        if (runningIdx >= 0) {
          steps[runningIdx].status = 'error';
          steps[runningIdx].message = 'Cancelled by user';
        }
        emitSteps(crashId, steps);
        saveHistory({ crashId, runAt: new Date().toISOString(), status: 'error', releaseTag: releaseBranch, steps: [...steps], errorMessage: 'Cancelled by user' });
        io.emit('pipeline:cancelled', { crashId });
      } else {
        if (runningIdx >= 0) {
          steps[runningIdx].status = 'error';
          steps[runningIdx].message = error.message;
        }
        emitSteps(crashId, steps);
        saveHistory({ crashId, runAt: new Date().toISOString(), status: 'error', releaseTag: releaseBranch, steps: [...steps], errorMessage: error.message });
        io.emit('pipeline:error', { crashId, error: error.message });
      }
    } finally {
      cancelFlags.delete(crashId);
    }
  });

  return router;
}
