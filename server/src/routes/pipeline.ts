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

// Store intermediate state for AI step (awaiting manual trigger)
interface AIWaitState {
  steps: PipelineStep[];
  crash: CrashReport;
  subject: string;
  swVersion: string;
  cdbCallStack: string;
  cdbExceptionType: string;
  cdbFaultingModule: string;
  cdbOutput: string;
  cdbTxtPath: string;
  repoDir: string;
  releaseBranch: string;
  dllNames: string[];
}
const aiWaitStates = new Map<string, AIWaitState>();

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

  router.post('/run-ai/:crashId', async (req, res) => {
    const crashId = req.params.crashId;
    const state = aiWaitStates.get(crashId);
    if (!state) return res.status(404).json({ error: 'No pending AI state. Please re-run the full pipeline.' });

    aiWaitStates.delete(crashId);
    res.json({ message: 'AI analysis started', crashId });

    const { steps, crash, subject, swVersion, cdbCallStack, cdbExceptionType, cdbFaultingModule, cdbOutput, cdbTxtPath, repoDir, releaseBranch, dllNames } = state;

    cancelFlags.set(crashId, false);
    const isCancelled = () => cancelFlags.get(crashId) === true;
    const throwIfCancelled = () => { if (isCancelled()) throw new Error('__CANCELLED__'); };

    const log = (stepIdx: number, line: string) => {
      if (!steps[stepIdx].logs) steps[stepIdx].logs = [];
      steps[stepIdx].logs!.push(line);
      emitSteps(crashId, steps);
    };

    try {
      // Step 7: Claude AI analysis
      steps[6].status = 'running';
      steps[6].message = undefined;
      emitSteps(crashId, steps);

      const sourceFiles = await getSourceFiles(repoDir, dllNames);

      const aiResult = await analyzeAndFix({
        callStack: cdbCallStack,
        exceptionType: cdbExceptionType,
        exceptionMessage: cdbOutput
          ? `[CDB Analysis]\n${cdbOutput.slice(0, 8000)}`
          : `Exception: ${cdbExceptionType}\nVersion: ${swVersion}`,
        faultingModule: cdbFaultingModule,
        cdbTxtPath,
        sourceFiles,
        onLog: (line) => log(6, line),
      });

      if (aiResult.fixedFiles.length === 0) {
        throw new Error(`AI analysis did not produce any file fixes.\nRoot cause: ${aiResult.rootCause}`);
      }

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
        `[CrashPilot] Fix ${cdbExceptionType} in ${cdbFaultingModule}\n\nReport #${crash.id} - v${swVersion}\n\n${aiResult.suggestedFix}`,
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
        crashSubject: subject,
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
        if (runningIdx >= 0) { steps[runningIdx].status = 'error'; steps[runningIdx].message = 'Cancelled by user'; }
        emitSteps(crashId, steps);
        saveHistory({ crashId, runAt: new Date().toISOString(), status: 'error', releaseTag: releaseBranch, steps: [...steps], errorMessage: 'Cancelled by user' });
        io.emit('pipeline:cancelled', { crashId });
      } else {
        if (runningIdx >= 0) { steps[runningIdx].status = 'error'; steps[runningIdx].message = error.message; }
        emitSteps(crashId, steps);
        saveHistory({ crashId, runAt: new Date().toISOString(), status: 'error', releaseTag: releaseBranch, steps: [...steps], errorMessage: error.message });
        io.emit('pipeline:error', { crashId, error: error.message });
      }
    } finally {
      cancelFlags.delete(crashId);
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
      { name: 'Clone / Pull', status: 'pending' },       // 3
      { name: 'Init Submodule', status: 'pending' },     // 4
      { name: 'Analyze Dump (CDB)', status: 'pending' }, // 5
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

      // Step 4: Clone or pull (skip if already cloned)
      const repoDir = getRepoDirForBranch(releaseBranch);
      const alreadyCloned = fs.existsSync(path.join(repoDir, '.git'));

      if (alreadyCloned) {
        steps[3].status = 'done';
        steps[3].message = `Already cloned: ${repoDir}`;
        log(3, `Skipped — repo already exists at ${repoDir}`);
        emitSteps(crashId, steps);
      } else {
        steps[3].status = 'running';
        emitSteps(crashId, steps);
        await checkoutBranch(releaseBranch, (line) => log(3, line));
        steps[3].status = 'done';
        steps[3].message = `${releaseBranch} → ${repoDir}`;
        emitSteps(crashId, steps);
      }
      throwIfCancelled();

      // Step 5: Init submodules (skip if no .gitmodules or already initialized)
      const gitmodulesPath = path.join(repoDir, '.gitmodules');
      const modulesDir = path.join(repoDir, '.git', 'modules');
      const hasSubmodules = fs.existsSync(gitmodulesPath);
      const alreadyInit = hasSubmodules && fs.existsSync(modulesDir) && fs.readdirSync(modulesDir).length > 0;

      if (!hasSubmodules || alreadyInit) {
        steps[4].status = 'done';
        steps[4].message = hasSubmodules ? 'Already initialized' : 'No submodules';
        log(4, hasSubmodules ? 'Skipped — submodules already initialized' : 'Skipped — no submodules in repo');
        emitSteps(crashId, steps);
      } else {
        steps[4].status = 'running';
        emitSteps(crashId, steps);
        await initSubmodules(repoDir, (line) => log(4, line));
        steps[4].status = 'done';
        steps[4].message = 'git submodule update --init done';
        emitSteps(crashId, steps);
      }
      throwIfCancelled();

      // Step 6: Analyze dump with CDB (skip if cached txt already exists)
      steps[5].status = 'running';
      emitSteps(crashId, steps);
      let cdbCallStack = callStack;        // fallback: use API stack trace
      let cdbExceptionType = exceptionType;
      let cdbFaultingModule = detail.stackTraces[0]?.dllName || 'Unknown';
      let cdbOutput = '';
      let cdbTxtPath = '';
      try {
        const dmpBase = path.basename(dmpPath, '.dmp');
        cdbTxtPath = path.join(pdbDir, `${dmpBase}_cdb.txt`);
        if (fs.existsSync(cdbTxtPath)) {
          cdbOutput = fs.readFileSync(cdbTxtPath, 'utf-8');
          log(5, `Using cached CDB output: ${cdbTxtPath}`);
        } else {
          cdbOutput = await analyzeDump(dmpPath, pdbDir, (line) => log(5, line));
        }
        const parsed = extractCallStack(cdbOutput);
        if (parsed.callStack) {
          cdbCallStack = parsed.callStack;
          cdbFaultingModule = parsed.faultingModule || cdbFaultingModule;
          if (parsed.exceptionType && parsed.exceptionType !== 'Unknown') {
            cdbExceptionType = parsed.exceptionType;
          }
        }
        steps[5].status = 'done';
        steps[5].message = `CDB analysis complete — ${cdbOutput.split('\n').length} lines`;
      } catch (cdbErr: any) {
        steps[5].status = 'done';
        steps[5].message = `CDB skipped: ${cdbErr.message.split('\n')[0]}`;
        log(5, `Warning: CDB failed — ${cdbErr.message}`);
        log(5, 'Falling back to API stack trace for AI analysis');
      }
      emitSteps(crashId, steps);
      throwIfCancelled();

      // Step 7: Pause — wait for manual AI trigger
      const dllNames = detail.stackTraces
        .map((s) => s.dllName)
        .filter(Boolean)
        .filter((name) => !name.startsWith('ntdll') && !name.startsWith('kernel'));
      const uniqueDlls = [...new Set(dllNames)];

      steps[6].status = 'awaiting';
      steps[6].message = 'Click "Run by AI" to start AI analysis';
      emitSteps(crashId, steps);

      aiWaitStates.set(crashId, {
        steps,
        crash,
        subject: detail.subject,
        swVersion: detail.swVersion,
        cdbCallStack,
        cdbExceptionType,
        cdbFaultingModule,
        cdbOutput,
        cdbTxtPath,
        repoDir,
        releaseBranch,
        dllNames: uniqueDlls,
      });

      io.emit('pipeline:awaiting_ai', { crashId });
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
