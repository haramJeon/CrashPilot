import { Router } from 'express';
import { Server as SocketIOServer } from 'socket.io';
import { downloadDump, analyzeDump, extractCallStack } from '../services/dump';
import { analyzeAndFix } from '../services/claude';
import { checkoutBranch, createFixBranch, applyFixes, commitAndPush, getSourceFiles } from '../services/git';
import { createPullRequest } from '../services/github';
import { CrashEmail, CrashAnalysis, PipelineStep } from '../types';
import { v4 as uuid } from 'uuid';

export function pipelineRouter(io: SocketIOServer): Router {
  const router = Router();

  function emitSteps(crashId: string, steps: PipelineStep[]) {
    io.emit('pipeline:steps', { crashId, steps });
  }

  // Run full pipeline for a crash
  router.post('/run/:crashId', async (req, res) => {
    const { crashId } = req.params;
    const crash: CrashEmail = req.body;

    const steps: PipelineStep[] = [
      { name: 'Download Dump', status: 'pending' },
      { name: 'Analyze Dump (CDB)', status: 'pending' },
      { name: 'Checkout Branch', status: 'pending' },
      { name: 'AI Analysis & Fix', status: 'pending' },
      { name: 'Apply Fix & Commit', status: 'pending' },
      { name: 'Create PR', status: 'pending' },
    ];

    res.json({ message: 'Pipeline started', crashId });

    try {
      // Step 1: Download dump
      steps[0].status = 'running';
      emitSteps(crashId, steps);
      const dumpFilename = `crash_${crashId.slice(0, 8)}_${Date.now()}.dmp`;
      const dumpPath = await downloadDump(crash.dumpUrl, dumpFilename);
      steps[0].status = 'done';
      steps[0].message = `Downloaded: ${dumpFilename}`;
      emitSteps(crashId, steps);

      // Step 2: Analyze with CDB
      steps[1].status = 'running';
      emitSteps(crashId, steps);
      const cdbOutput = analyzeDump(dumpPath);
      const { callStack, exceptionType, exceptionMessage, faultingModule } = extractCallStack(cdbOutput);
      steps[1].status = 'done';
      steps[1].message = `Exception: ${exceptionType}`;
      emitSteps(crashId, steps);

      // Step 3: Checkout release branch
      steps[2].status = 'running';
      emitSteps(crashId, steps);
      await checkoutBranch(crash.releaseBranch);
      steps[2].status = 'done';
      steps[2].message = `Branch: ${crash.releaseBranch}`;
      emitSteps(crashId, steps);

      // Step 4: Claude AI analysis
      steps[3].status = 'running';
      emitSteps(crashId, steps);

      // Extract file paths from call stack (heuristic)
      const filePathMatches = callStack.match(/[\w/\\]+\.\w+/g) || [];
      const uniquePaths = [...new Set(filePathMatches)];
      const sourceFiles = await getSourceFiles(uniquePaths);

      const aiResult = await analyzeAndFix({
        callStack,
        exceptionType,
        exceptionMessage,
        faultingModule,
        sourceFiles,
      });
      steps[3].status = 'done';
      steps[3].message = `Root cause identified, ${aiResult.fixedFiles.length} file(s) to fix`;
      emitSteps(crashId, steps);

      // Step 5: Apply fix
      steps[4].status = 'running';
      emitSteps(crashId, steps);
      const fixBranch = await createFixBranch(crash.releaseBranch, crashId.slice(0, 8));
      await applyFixes(aiResult.fixedFiles);
      await commitAndPush(
        aiResult.fixedFiles,
        `[CrashPilot] Fix crash: ${exceptionType} in ${faultingModule}\n\n${aiResult.suggestedFix}`
      );
      steps[4].status = 'done';
      steps[4].message = `Pushed to ${fixBranch}`;
      emitSteps(crashId, steps);

      // Step 6: Create PR
      steps[5].status = 'running';
      emitSteps(crashId, steps);

      const analysis: CrashAnalysis = {
        callStack,
        exceptionType,
        exceptionMessage,
        faultingModule,
        ...aiResult,
      };

      const prUrl = await createPullRequest({
        branch: fixBranch,
        baseBranch: crash.releaseBranch,
        crashSubject: crash.subject,
        analysis,
      });

      analysis.prUrl = prUrl;

      steps[5].status = 'done';
      steps[5].message = prUrl;
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
