import { spawn } from 'child_process';
import * as path from 'path';
import { FixedFile } from '../types';

function runClaude(
  prompt: string,
  cwd?: string,
  allowedDirs?: string[],
  onLog?: (line: string) => void,
  shouldAbort?: () => boolean,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ['--print'];
    for (const dir of allowedDirs ?? []) {
      args.push('--add-dir', dir);
    }
    const proc = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'], cwd });

    proc.stdin.write(prompt, 'utf-8');
    proc.stdin.end();

    const outLines: string[] = [];
    const errLines: string[] = [];
    let outRemainder = '';
    let errRemainder = '';

    proc.stdout.on('data', (chunk: Buffer) => {
      const text = outRemainder + chunk.toString('utf-8');
      const lines = text.split('\n');
      outRemainder = lines.pop() ?? '';
      for (const line of lines) {
        outLines.push(line);
        onLog?.(line);
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      const text = errRemainder + chunk.toString('utf-8');
      const lines = text.split('\n');
      errRemainder = lines.pop() ?? '';
      for (const line of lines) {
        errLines.push(line);
        onLog?.(`[stderr] ${line}`);
      }
    });

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('Claude CLI timed out after 10 minutes'));
    }, 600000);

    const abortPoller = shouldAbort
      ? setInterval(() => {
          if (shouldAbort()) {
            clearInterval(abortPoller);
            proc.kill();
            reject(new Error('__CANCELLED__'));
          }
        }, 1000)
      : undefined;

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (abortPoller) clearInterval(abortPoller);
      if (outRemainder) { outLines.push(outRemainder); onLog?.(outRemainder); }
      if (errRemainder) { errLines.push(errRemainder); onLog?.(`[stderr] ${errRemainder}`); }
      if (code === 0) {
        resolve(outLines.join('\n'));
      } else {
        reject(new Error(errLines.join('\n') || `claude exited with code ${code}`));
      }
    });

    proc.on('error', (e) => { clearTimeout(timer); if (abortPoller) clearInterval(abortPoller); reject(e); });
  });
}

export async function analyzeAndFix(params: {
  exceptionType: string;
  faultingModule: string;
  cdbTxtPath?: string;
  repoDir?: string;
  onLog?: (line: string) => void;
  shouldAbort?: () => boolean;
}): Promise<{
  rootCause: string;
  suggestedFix: string;
  fixedFiles: FixedFile[];
}> {
  const { onLog } = params;

  const prompt = `C++ crash analysis. Read the CDB output file, find the relevant source files, and fix the crash.

${params.cdbTxtPath ? `CDB output: ${params.cdbTxtPath}` : `Exception: ${params.exceptionType} in ${params.faultingModule} (no CDB file available)`}

Source repo is your current working directory. Find the relevant source files yourself.

Rules:
- Read the CDB file for the full crash details: call stack, exception, registers, symbol info
- Identify the crashing function (first non-OS frame in the call stack)
- Search the repo for the relevant source files
- Produce the minimal fix
- Only include files you actually change

Reply with ONLY this JSON (no markdown):
{"rootCause":"<function> — <reason>","suggestedFix":"<what changed>","fixedFiles":[{"path":"...","content":"..."}]}`;

  onLog?.(`[AI] Exception: ${params.exceptionType} | Module: ${params.faultingModule}`);
  onLog?.(`[AI] CDB file : ${params.cdbTxtPath || '(none)'}`);
  onLog?.(`[AI] RepoDir  : ${params.repoDir || '(none)'}`);
  onLog?.(`[AI] Prompt   : ${prompt.length} chars`);
  onLog?.(`[AI] ── Prompt ─────────────────────`);
  for (const line of prompt.split('\n')) onLog?.(line);
  onLog?.(`[AI] ────────────────────────────────`);
  onLog?.(`[AI] Sending to claude CLI...`);

  const allowedDirs = params.cdbTxtPath ? [path.dirname(params.cdbTxtPath)] : [];

  const text = await runClaude(prompt, params.repoDir, allowedDirs, onLog, params.shouldAbort);
  onLog?.(`[AI] Response received — ${text.length} chars`);

  try {
    const result = JSON.parse(text.trim());
    const fixedFiles: FixedFile[] = (result.fixedFiles || []).map((f: any) => {
      const original = '';
      return {
        path: f.path,
        original,
        modified: f.content,
        diff: generateSimpleDiff(original, f.content),
      };
    });

    onLog?.(`[AI] Parsed OK — rootCause: ${result.rootCause?.slice(0, 80)}...`);
    onLog?.(`[AI] fixedFiles: ${fixedFiles.length} file(s)`);
    return {
      rootCause: result.rootCause || 'Analysis failed',
      suggestedFix: result.suggestedFix || '',
      fixedFiles,
    };
  } catch {
    onLog?.(`[AI] JSON parse failed — raw response: ${text.slice(0, 200)}`);
    return {
      rootCause: text,
      suggestedFix: 'Could not parse structured response',
      fixedFiles: [],
    };
  }
}

function generateSimpleDiff(original: string, modified: string): string {
  const origLines = original.split('\n');
  const modLines = modified.split('\n');
  const diff: string[] = [];

  const maxLen = Math.max(origLines.length, modLines.length);
  for (let i = 0; i < maxLen; i++) {
    const origLine = origLines[i];
    const modLine = modLines[i];
    if (origLine !== modLine) {
      if (origLine !== undefined) diff.push(`- ${origLine}`);
      if (modLine !== undefined) diff.push(`+ ${modLine}`);
    }
  }

  return diff.join('\n');
}
