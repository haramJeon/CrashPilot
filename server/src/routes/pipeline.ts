import fs from 'fs';
import path from 'path';
import { Router } from 'express';
import { Server as SocketIOServer } from 'socket.io';
import { fetchReportDetail, formatCallStack } from '../services/crashReportServer';
import { analyzeAndFix } from '../services/claude';
import { downloadPdbFiles, downloadDump, analyzeDump, extractCallStack } from '../services/dump';
import { checkoutBranch, createFixBranch, commitAndPush, initSubmodules, getRepoDirForBranch } from '../services/git';
import { createPullRequest } from '../services/github';
import { updateCrashRecord, getCrashRecord } from './crash';
import type { CrashReport, CrashAnalysis, PipelineStep, PipelineRunHistory, PipelineState } from '../types';

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
  pdbDir: string;
  dmpPath: string;
  releaseBranch: string;
  pipelineState: PipelineState;
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

    // Cancel while waiting for manual AI trigger
    if (aiWaitStates.has(crashId)) {
      const state = aiWaitStates.get(crashId)!;
      aiWaitStates.delete(crashId);
      const awaitingIdx = state.steps.findIndex((s) => s.status === 'awaiting');
      if (awaitingIdx >= 0) {
        state.steps[awaitingIdx].status = 'error';
        state.steps[awaitingIdx].message = 'Cancelled by user';
      }
      emitSteps(crashId, state.steps);
      saveHistory({ crashId, runAt: new Date().toISOString(), status: 'error', releaseTag: state.releaseBranch, steps: [...state.steps], errorMessage: 'Cancelled by user', pipelineState: state.pipelineState });
      io.emit('pipeline:cancelled', { crashId });
      return res.json({ message: 'Cancel requested' });
    }

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

    const { steps, crash, subject, swVersion, cdbCallStack, cdbExceptionType, cdbFaultingModule, cdbOutput, cdbTxtPath, pdbDir, dmpPath, releaseBranch, pipelineState } = state;

    cancelFlags.set(crashId, false);
    const isCancelled = () => cancelFlags.get(crashId) === true;
    const throwIfCancelled = () => { if (isCancelled()) throw new Error('__CANCELLED__'); };

    const log = (stepIdx: number, line: string) => {
      if (!steps[stepIdx].logs) steps[stepIdx].logs = [];
      steps[stepIdx].logs!.push(line);
      emitSteps(crashId, steps);
    };

    try {
      // Step 4 (gate): mark done immediately — user confirmed by clicking
      steps[4].status = 'done';
      steps[4].message = 'Confirmed';
      emitSteps(crashId, steps);

      // Step 5: Clone or pull
      const repoDir = getRepoDirForBranch(releaseBranch);
      const alreadyCloned = fs.existsSync(path.join(repoDir, '.git'));

      if (alreadyCloned) {
        steps[5].status = 'done';
        steps[5].message = `Already cloned: ${repoDir}`;
        log(5, `Skipped — repo already exists at ${repoDir}`);
      } else {
        steps[5].status = 'running';
        emitSteps(crashId, steps);
        await checkoutBranch(releaseBranch, (line) => log(5, line));
        steps[5].status = 'done';
        steps[5].message = `${releaseBranch} → ${repoDir}`;
      }
      emitSteps(crashId, steps);
      throwIfCancelled();

      // Step 6: Init submodules
      const gitmodulesPath = path.join(repoDir, '.gitmodules');
      const modulesDir = path.join(repoDir, '.git', 'modules');
      const hasSubmodules = fs.existsSync(gitmodulesPath);
      const alreadyInit = hasSubmodules && fs.existsSync(modulesDir) && fs.readdirSync(modulesDir).length > 0;

      if (!hasSubmodules || alreadyInit) {
        steps[6].status = 'done';
        steps[6].message = hasSubmodules ? 'Already initialized' : 'No submodules';
        log(6, hasSubmodules ? 'Skipped — submodules already initialized' : 'Skipped — no submodules in repo');
      } else {
        steps[6].status = 'running';
        emitSteps(crashId, steps);
        await initSubmodules(repoDir, (line) => log(6, line));
        steps[6].status = 'done';
        steps[6].message = 'git submodule update --init done';
      }
      emitSteps(crashId, steps);
      throwIfCancelled();

      // Step 7: Create fix branch + Claude AI analysis
      // Fix branch is created first (resets to clean base), then Claude writes directly into the repo
      steps[7].status = 'running';
      steps[7].message = undefined;
      emitSteps(crashId, steps);

      const { branchName: fixBranch } = await createFixBranch(releaseBranch, String(crash.id), (line) => log(7, line));

      const aiResult = await analyzeAndFix({
        exceptionType: cdbExceptionType,
        faultingModule: cdbFaultingModule,
        cdbTxtPath,
        repoDir,
        onLog: (line) => log(7, line),
        shouldAbort: isCancelled,
      });

      if (aiResult.fixedFiles.length === 0) {
        throw new Error(`AI analysis did not produce any file fixes.\nRoot cause: ${aiResult.rootCause}`);
      }

      steps[7].status = 'done';
      steps[7].message = `Root cause identified - ${aiResult.fixedFiles.length} file(s) to fix`;
      emitSteps(crashId, steps);
      throwIfCancelled();

      // Step 8: Commit & push (Claude already wrote the files — just commit)
      steps[8].status = 'running';
      emitSteps(crashId, steps);

      await commitAndPush(
        repoDir,
        aiResult.fixedFiles,
        `[CrashPilot] Fix ${cdbExceptionType} in ${cdbFaultingModule}\n\nReport #${crash.id} - v${swVersion}\n\n${aiResult.suggestedFix}`,
        (line) => log(8, line)
      );

      steps[8].status = 'done';
      steps[8].message = `Pushed to ${fixBranch}`;
      emitSteps(crashId, steps);

      // Step 9: Create PR
      steps[9].status = 'running';
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
      steps[9].status = 'done';
      steps[9].message = prUrl;
      emitSteps(crashId, steps);

      saveHistory({ crashId, runAt: new Date().toISOString(), status: 'completed', releaseTag: releaseBranch, steps: [...steps], analysis, pipelineState });
      io.emit('pipeline:complete', { crashId, analysis });
    } catch (error: any) {
      const runningIdx = steps.findIndex((s) => s.status === 'running');
      if (error.message === '__CANCELLED__') {
        if (runningIdx >= 0) { steps[runningIdx].status = 'error'; steps[runningIdx].message = 'Cancelled by user'; }
        emitSteps(crashId, steps);
        saveHistory({ crashId, runAt: new Date().toISOString(), status: 'error', releaseTag: releaseBranch, steps: [...steps], errorMessage: 'Cancelled by user', pipelineState });
        io.emit('pipeline:cancelled', { crashId });
      } else {
        if (runningIdx >= 0) { steps[runningIdx].status = 'error'; steps[runningIdx].message = error.message; }
        emitSteps(crashId, steps);
        saveHistory({ crashId, runAt: new Date().toISOString(), status: 'error', releaseTag: releaseBranch, steps: [...steps], errorMessage: error.message, pipelineState });
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
      { name: 'Load Stack Trace',   status: 'pending' }, // 0  auto
      { name: 'Download PDB Files', status: 'pending' }, // 1  auto
      { name: 'Download Dump',      status: 'pending' }, // 2  auto
      { name: 'Analyze Dump (CDB)', status: 'pending' }, // 3  auto
      { name: 'Run by AI',          status: 'pending' }, // 4  awaiting (gate)
      { name: 'Clone / Pull',       status: 'pending' }, // 5  after click
      { name: 'Init Submodule',     status: 'pending' }, // 6  after click
      { name: 'AI Analysis & Fix',  status: 'pending' }, // 7  after click
      { name: 'Apply Fix & Commit', status: 'pending' }, // 8  after click
      { name: 'Create PR',          status: 'pending' }, // 9  after click
    ];

    res.json({ message: 'Pipeline started', crashId });

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
      // Step 0: Load stack trace
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

      // Step 1: Download PDB files
      steps[1].status = 'running';
      emitSteps(crashId, steps);
      const pdbDir = await downloadPdbFiles(detail.softwareId, detail.swVersion, (line) => log(1, line));
      steps[1].status = 'done';
      steps[1].message = pdbDir;
      emitSteps(crashId, steps);
      throwIfCancelled();

      // Step 2: Download crash dump
      steps[2].status = 'running';
      emitSteps(crashId, steps);
      const dmpPath = await downloadDump(crashId, crash.dumpUrl, pdbDir, (line) => log(2, line));
      steps[2].status = 'done';
      steps[2].message = dmpPath;
      emitSteps(crashId, steps);
      throwIfCancelled();

      // Step 3: Analyze dump with CDB
      steps[3].status = 'running';
      emitSteps(crashId, steps);
      let cdbCallStack = callStack;
      let cdbExceptionType = exceptionType;
      let cdbFaultingModule = detail.stackTraces[0]?.dllName || 'Unknown';
      let cdbOutput = '';
      let cdbTxtPath = '';
      try {
        const dmpBase = path.basename(dmpPath, '.dmp');
        cdbTxtPath = path.join(pdbDir, `${dmpBase}_cdb.txt`);
        if (fs.existsSync(cdbTxtPath)) {
          cdbOutput = fs.readFileSync(cdbTxtPath, 'utf-8');
          log(3, `Using cached CDB output: ${cdbTxtPath}`);
        } else {
          cdbOutput = await analyzeDump(dmpPath, pdbDir, (line) => log(3, line));
        }
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
        steps[3].status = 'done';
        steps[3].message = `CDB skipped: ${cdbErr.message.split('\n')[0]}`;
        log(3, `Warning: CDB failed — ${cdbErr.message}`);
        log(3, 'Falling back to API stack trace for AI analysis');
      }
      emitSteps(crashId, steps);
      throwIfCancelled();

      // Build pipeline state snapshot for history / retry
      const pipelineState: PipelineState = {
        pdbDir,
        dmpPath,
        cdbTxtPath,
        cdbCallStack,
        cdbExceptionType,
        cdbFaultingModule,
        releaseBranch,
      };

      // Pause — wait for manual AI trigger
      steps[4].status = 'awaiting';
      steps[4].message = 'Click "Run by AI" to continue';
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
        pdbDir,
        dmpPath,
        releaseBranch,
        pipelineState,
      });

      io.emit('pipeline:awaiting_ai', { crashId });
    } catch (error: any) {
      const runningIdx = steps.findIndex((s) => s.status === 'running');
      // pipelineState may be incomplete at this point — save what we have (undefined is fine for the type)
      const partialState: PipelineState | undefined = undefined;
      if (error.message === '__CANCELLED__') {
        if (runningIdx >= 0) {
          steps[runningIdx].status = 'error';
          steps[runningIdx].message = 'Cancelled by user';
        }
        emitSteps(crashId, steps);
        saveHistory({ crashId, runAt: new Date().toISOString(), status: 'error', releaseTag: releaseBranch, steps: [...steps], errorMessage: 'Cancelled by user', pipelineState: partialState });
        io.emit('pipeline:cancelled', { crashId });
      } else {
        if (runningIdx >= 0) {
          steps[runningIdx].status = 'error';
          steps[runningIdx].message = error.message;
        }
        emitSteps(crashId, steps);
        saveHistory({ crashId, runAt: new Date().toISOString(), status: 'error', releaseTag: releaseBranch, steps: [...steps], errorMessage: error.message, pipelineState: partialState });
        io.emit('pipeline:error', { crashId, error: error.message });
      }
    } finally {
      cancelFlags.delete(crashId);
    }
  });

  router.post('/retry/:crashId/:fromStep', async (req, res) => {
    const crashId = req.params.crashId;
    const fromStep = parseInt(req.params.fromStep, 10);

    if (isNaN(fromStep) || fromStep < 0 || fromStep > 9) {
      return res.status(400).json({ error: 'Invalid fromStep' });
    }

    const history = loadHistory(crashId);
    if (!history) return res.status(404).json({ error: 'No history found for this crash' });

    if (fromStep <= 4) {
      // Re-run from beginning
      aiWaitStates.delete(crashId);
      cancelFlags.delete(crashId);
      return res.json({ action: 'rerun' });
    }

    // fromStep 5-9: restore aiWaitState from history pipelineState
    const ps = history.pipelineState;
    if (!ps) return res.status(400).json({ error: 'No saved pipeline state in history' });

    // Reset steps from fromStep onwards to 'pending'
    const steps: PipelineStep[] = history.steps.map((s, i) => {
      if (i >= fromStep) return { name: s.name, status: 'pending' };
      return { ...s };
    });
    // Ensure gate step 4 is marked done
    if (steps[4]) steps[4] = { name: steps[4].name, status: 'done', message: 'Confirmed' };

    const crash = getCrashRecord(Number(crashId));
    if (!crash) return res.status(404).json({ error: 'Crash record not found' });

    aiWaitStates.set(crashId, {
      steps,
      crash,
      subject: crash.subject || '',
      swVersion: crash.swVersion || '',
      cdbCallStack: ps.cdbCallStack,
      cdbExceptionType: ps.cdbExceptionType,
      cdbFaultingModule: ps.cdbFaultingModule,
      cdbOutput: '',
      cdbTxtPath: ps.cdbTxtPath,
      pdbDir: ps.pdbDir,
      dmpPath: ps.dmpPath,
      releaseBranch: ps.releaseBranch,
      pipelineState: ps,
    });

    emitSteps(crashId, steps);
    io.emit('pipeline:awaiting_ai', { crashId });

    res.json({ action: 'restored', fromStep });
  });

  return router;
}
