import { spawn, execSync, ChildProcess } from 'child_process';
import * as path from 'path';
import { FixedFile } from '../types';

async function ensureClaudeCli(onLog?: (line: string) => void): Promise<void> {
  try {
    execSync('claude --version', { stdio: 'ignore', timeout: 5000 });
    return; // already installed
  } catch { /* not found — install below */ }

  onLog?.('[Claude] claude CLI not found. Installing via npm...');
  onLog?.('[Claude] Running: npm install -g @anthropic-ai/claude-code');

  await new Promise<void>((resolve, reject) => {
    const proc = spawn('npm', ['install', '-g', '@anthropic-ai/claude-code'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });

    proc.stdout?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (line.trim()) onLog?.(`[npm] ${line}`);
      }
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (line.trim()) onLog?.(`[npm] ${line}`);
      }
    });

    proc.on('close', (code) => {
      if (code === 0) {
        onLog?.('[Claude] Installation complete.');
        resolve();
      } else {
        reject(new Error(`npm install -g @anthropic-ai/claude-code failed with code ${code}`));
      }
    });
    proc.on('error', reject);
  });

  // Verify installation succeeded
  try {
    execSync('claude --version', { stdio: 'ignore', timeout: 5000 });
  } catch {
    throw new Error('claude CLI installation failed. Please run: npm install -g @anthropic-ai/claude-code');
  }
}

function killProcess(proc: ChildProcess): void {
  if (!proc.pid) return;
  try {
    if (process.platform === 'win32') {
      // On Windows, kill the entire process tree (claude may spawn child tool processes)
      spawn('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { stdio: 'ignore' });
    } else {
      proc.kill('SIGKILL');
    }
  } catch {
    // ignore errors during cleanup
  }
}

function runClaude(
  prompt: string,
  cwd?: string,
  allowedDirs?: string[],
  onLog?: (line: string) => void,
  shouldAbort?: () => boolean,
  model?: string,
): { promise: Promise<string>; kill: () => void } {
  let proc: ChildProcess | null = null;

  const promise = new Promise<string>((resolve, reject) => {
    const args = ['--print', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--dangerously-skip-permissions'];
    if (model) {
      args.push('--model', model);
    }
    for (const dir of allowedDirs ?? []) {
      args.push('--add-dir', dir);
    }
    proc = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'], cwd });

    proc.stdin!.write(prompt, 'utf-8');
    proc.stdin!.end();

    let finalResult = '';
    const errLines: string[] = [];
    let outRemainder = '';
    let errRemainder = '';

    proc.stdout!.on('data', (chunk: Buffer) => {
      const text = outRemainder + chunk.toString('utf-8');
      const lines = text.split('\n');
      outRemainder = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          handleStreamEvent(event, onLog);
          if (event.type === 'result' && event.result) {
            finalResult = event.result;
          }
        } catch {
          onLog?.(line);
        }
      }
    });

    proc.stderr!.on('data', (chunk: Buffer) => {
      const text = errRemainder + chunk.toString('utf-8');
      const lines = text.split('\n');
      errRemainder = lines.pop() ?? '';
      for (const line of lines) {
        errLines.push(line);
        onLog?.(`[stderr] ${line}`);
      }
    });

    const timer = setTimeout(() => {
      if (proc) killProcess(proc);
      reject(new Error('Claude CLI timed out after 10 minutes'));
    }, 600000);

    const abortPoller = shouldAbort
      ? setInterval(() => {
          if (shouldAbort()) {
            clearInterval(abortPoller);
            if (proc) killProcess(proc);
            reject(new Error('__CANCELLED__'));
          }
        }, 1000)
      : undefined;

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (abortPoller) clearInterval(abortPoller);
      if (outRemainder.trim()) {
        try {
          const event = JSON.parse(outRemainder);
          handleStreamEvent(event, onLog);
          if (event.type === 'result' && event.result) finalResult = event.result;
        } catch { onLog?.(outRemainder); }
      }
      if (errRemainder) { errLines.push(errRemainder); onLog?.(`[stderr] ${errRemainder}`); }
      if (code === 0) {
        resolve(finalResult);
      } else {
        reject(new Error(errLines.join('\n') || `claude exited with code ${code}`));
      }
    });

    proc.on('error', (e) => {
      clearTimeout(timer);
      if (abortPoller) clearInterval(abortPoller);
      reject(e);
    });
  });

  return {
    promise,
    kill: () => { if (proc) killProcess(proc!); },
  };
}

function handleStreamEvent(event: any, onLog?: (line: string) => void): void {
  if (!onLog) return;
  switch (event.type) {
    case 'assistant': {
      const content = event.message?.content ?? [];
      for (const block of content) {
        if (block.type === 'text' && block.text?.trim()) {
          for (const line of block.text.trim().split('\n')) {
            if (line.trim()) onLog(`[claude] ${line}`);
          }
        } else if (block.type === 'tool_use') {
          const input = block.input ?? {};
          const detail =
            input.command ?? input.file_path ?? input.path ?? input.pattern ?? JSON.stringify(input).slice(0, 120);
          onLog(`[tool:${block.name}] ${detail}`);
        }
      }
      break;
    }
    case 'result':
      onLog(`[result] subtype=${event.subtype} cost=$${event.total_cost_usd?.toFixed(4) ?? '?'}`);
      break;
    case 'system':
      if (event.subtype === 'init') onLog(`[init] tools: ${(event.tools ?? []).map((t: any) => t.name ?? t).join(', ')}`);
      break;
  }
}

export async function analyzeAndFix(params: {
  exceptionType: string;
  faultingModule: string;
  cdbTxtPath?: string;
  repoDir?: string;
  onLog?: (line: string) => void;
  shouldAbort?: () => boolean;
  model?: string;
  customPrompt?: string;
}): Promise<{
  rootCause: string;
  suggestedFix: string;
  fixedFiles: FixedFile[];
}> {
  const { onLog } = params;

  const jsonFooter = `\n\nReply with ONLY this JSON (no markdown, paths must be relative to repo root). Write rootCause and suggestedFix values in Korean:\n{"rootCause":"<function> — <reason>","suggestedFix":"<what changed>","fixedFiles":[{"path":"relative/path/to/file.cpp","content":"<FULL file content>"}]}`;

  const prompt = params.customPrompt?.trim()
    ? `${params.customPrompt.trim()}${jsonFooter}`
    : `C++ crash analysis. Fix the crash with MINIMAL context usage — follow every rule below exactly.

${params.cdbTxtPath ? `CDB output: ${params.cdbTxtPath}` : `Exception: ${params.exceptionType} in ${params.faultingModule} (no CDB file available)`}

Source repo is your current working directory.

## Context Minimization Rules (MANDATORY):

### Reading the CDB file
- NEVER read the entire CDB file.
- Step 1: Grep for key sections first:
    grep -n "EXCEPTION_RECORD\\|STACK_TEXT\\|ChildEBP\\|RetAddr\\|ExceptionAddress" <cdb_file> | head -30
- Step 2: Read only those lines with offset+limit (e.g. Read file offset=N limit=60).

### Finding source files
- Use Grep with a file-type filter — NEVER recursive grep without --include:
    grep -rn "functionName" <specific_subdir> --include="*.cpp"
    grep -rn "functionName" <specific_subdir> --include="*.h"
- Narrow the search path as much as possible (e.g. "source/payment/" not the whole repo root).

### Reading source files
- NEVER read an entire source file.
- Step 1: Grep to find the exact line number of the crashing function.
- Step 2: Read only ±40 lines around that function (offset+limit).
- NEVER read the same file twice — extract everything needed in one read.

### General
- Stop searching as soon as you have identified the crashing function and its source lines.
- Do not explore unrelated files or directories.

## Analysis Steps:
1. Grep the CDB file for exception/stack keywords → find the faulting function name (first non-OS frame).
2. Grep the repo for that function name with --include="*.cpp" filter in the most specific subdir.
3. Read only the crashing function body (offset+limit ±40 lines).
4. Produce the minimal fix — touch only the lines that cause the crash.
5. Only include files you actually change; paths must be relative to the repo root.
${jsonFooter}`;

  onLog?.(`[AI] Exception: ${params.exceptionType} | Module: ${params.faultingModule}`);
  onLog?.(`[AI] CDB file : ${params.cdbTxtPath || '(none)'}`);
  onLog?.(`[AI] RepoDir  : ${params.repoDir || '(none)'}`);
  onLog?.(`[AI] Prompt   : ${prompt.length} chars`);
  onLog?.(`[AI] ── Prompt ─────────────────────`);
  for (const line of prompt.split('\n')) onLog?.(line);
  onLog?.(`[AI] ────────────────────────────────`);
  onLog?.(`[AI] Sending to claude CLI...`);
  await ensureClaudeCli(onLog);

  const allowedDirs = params.cdbTxtPath ? [path.dirname(params.cdbTxtPath)] : [];

  const { promise, kill } = runClaude(prompt, params.repoDir, allowedDirs, onLog, params.shouldAbort, params.model);
  let text: string;
  try {
    text = await promise;
  } finally {
    kill();
    onLog?.(`[AI] Claude session terminated`);
  }
  onLog?.(`[AI] Response received — ${text!.length} chars`);

  // Extract JSON object from response even if surrounded by explanatory text
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  const jsonText = jsonMatch ? jsonMatch[0] : text;

  try {
    const result = JSON.parse(jsonText);
    const repoDirNorm = (params.repoDir ?? '').replace(/\\/g, '/').replace(/\/?$/, '/');
    const fixedFiles: FixedFile[] = (result.fixedFiles || []).map((f: any) => {
      // Normalize absolute paths returned by Claude to repo-relative
      const rawPath: string = (f.path ?? '').replace(/\\/g, '/');
      const relPath = repoDirNorm && rawPath.startsWith(repoDirNorm)
        ? rawPath.slice(repoDirNorm.length)
        : rawPath;
      const original = '';
      return {
        path: relPath,
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
