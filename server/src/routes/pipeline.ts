import { Router } from 'express';
import { Server as SocketIOServer } from 'socket.io';
import { fetchReportDetail, formatCallStack, getReleaseBranch } from '../services/crashReportServer';
import { analyzeAndFix } from '../services/claude';
import { checkoutBranch, createFixBranch, applyFixes, commitAndPush, getSourceFiles } from '../services/git';
import { createPullRequest } from '../services/github';
import type { CrashReport, CrashAnalysis, PipelineStep } from '../types';

export function pipelineRouter(io: SocketIOServer): Router {
  const router = Router();

  function emitSteps(crashId: string, steps: PipelineStep[]) {
    io.emit('pipeline:steps', { crashId, steps });
  }

  router.post('/run/:crashId', async (req, res) => {
    const crashId = req.params.crashId;
    const crash: CrashReport = req.body;

    const steps: PipelineStep[] = [
      { name: 'Load Stack Trace', status: 'pending' },
      { name: 'Checkout Branch', status: 'pending' },
      { name: 'AI Analysis & Fix', status: 'pending' },
      { name: 'Apply Fix & Commit', status: 'pending' },
      { name: 'Create PR', status: 'pending' },
    ];

    res.json({ message: 'Pipeline started', crashId });

    try {
      // Step 1: Load stack trace from API (already parsed by crashReportOrganizer)
      steps[0].status = 'running';
      emitSteps(crashId, steps);

      const detail = await fetchReportDetail(crash.id);
      const callStack = formatCallStack(detail);
      const exceptionType = detail.exceptionCode || detail.bugcheck || 'Unknown Exception';
      const releaseBranch = getReleaseBranch(detail);

      steps[0].status = 'done';
      steps[0].message = `${detail.stackTraces.length + detail.mainStackTraces.length} frames · ${exceptionType}`;
      emitSteps(crashId, steps);

      // Step 2: Checkout release branch
      steps[1].status = 'running';
      emitSteps(crashId, steps);
      await checkoutBranch(releaseBranch);
      steps[1].status = 'done';
      steps[1].message = `Branch: ${releaseBranch}`;
      emitSteps(crashId, steps);

      // Step 3: Claude AI analysis
      steps[2].status = 'running';
      emitSteps(crashId, steps);

      // Extract source file paths from dll names in stack trace
      const dllNames = detail.stackTraces
        .map((s) => s.dllName)
        .filter(Boolean)
        .filter((name) => !name.startsWith('ntdll') && !name.startsWith('kernel'));
      const uniqueDlls = [...new Set(dllNames)];
      const sourceFiles = await getSourceFiles(uniqueDlls);

      const aiResult = await analyzeAndFix({
        callStack,
        exceptionType,
        exceptionMessage: `Exception: ${exceptionType}\nVersion: ${detail.swVersion}\nRegion: ${detail.region || 'N/A'}`,
        faultingModule: detail.stackTraces[0]?.dllName || 'Unknown',
        sourceFiles,
      });

      steps[2].status = 'done';
      steps[2].message = `Root cause identified · ${aiResult.fixedFiles.length} file(s) to fix`;
      emitSteps(crashId, steps);

      // Step 4: Apply fix & commit
      steps[3].status = 'running';
      emitSteps(crashId, steps);
      const fixBranch = await createFixBranch(releaseBranch, String(crash.id));
      await applyFixes(aiResult.fixedFiles);
      await commitAndPush(
        aiResult.fixedFiles,
        `[CrashPilot] Fix ${exceptionType} in ${detail.stackTraces[0]?.dllName || 'unknown'}\n\nReport #${crash.id} · v${detail.swVersion}\n\n${aiResult.suggestedFix}`
      );
      steps[3].status = 'done';
      steps[3].message = `Pushed to ${fixBranch}`;
      emitSteps(crashId, steps);

      // Step 5: Create PR
      steps[4].status = 'running';
      emitSteps(crashId, steps);

      const analysis: CrashAnalysis = {
        callStack,
        exceptionType,
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
      steps[4].status = 'done';
      steps[4].message = prUrl;
      emitSteps(crashId, steps);

      io.emit('pipeline:complete', { crashId, analysis });
    } catch (error: any) {
      const runningIdx = steps.findIndex((s) => s.status === 'running');
      if (runningIdx >= 0) {
        steps[runningIdx].status = 'error';
        steps[runningIdx].message = error.message;
      }
      emitSteps(crashId, steps);
      io.emit('pipeline:error', { crashId, error: error.message });
    }
  });

  return router;
}
