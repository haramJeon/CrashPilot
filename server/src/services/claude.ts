import { spawn } from 'child_process';
import { FixedFile } from '../types';

function runClaude(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', ['--print'], { stdio: ['pipe', 'pipe', 'pipe'] });

    proc.stdin.write(prompt, 'utf-8');
    proc.stdin.end();

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    proc.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    proc.stderr.on('data', (chunk: Buffer) => err.push(chunk));

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('Claude CLI timed out after 10 minutes'));
    }, 600000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(Buffer.concat(out).toString('utf-8'));
      } else {
        reject(new Error(Buffer.concat(err).toString('utf-8') || `claude exited with code ${code}`));
      }
    });

    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

export async function analyzeAndFix(params: {
  callStack: string;
  exceptionType: string;
  faultingModule: string;
  cdbTxtPath?: string;
  sourceFiles: { path: string; content: string }[];
  onLog?: (line: string) => void;
}): Promise<{
  rootCause: string;
  suggestedFix: string;
  fixedFiles: FixedFile[];
}> {
  const { onLog } = params;

  const sourceContext = params.sourceFiles
    .map((f) => `--- ${f.path} ---\n${f.content}`)
    .join('\n\n');

  const prompt = `C++ crash analysis. Read the CDB output file for full details, then fix the source code.

Exception: ${params.exceptionType} in ${params.faultingModule}
${params.cdbTxtPath ? `CDB output: ${params.cdbTxtPath} (read this file for the full crash details)` : ''}

Call stack (find the first non-OS frame — that is the crash site):
${params.callStack}

Source files to fix:
${sourceContext || '(none — infer from call stack)'}

Rules:
- Read the CDB file above for exception details, registers, and symbol info
- Identify the exact crashing function from the call stack
- Produce the minimal fix
- Only include files you actually change

Reply with ONLY this JSON (no markdown):
{"rootCause":"<function> — <reason>","suggestedFix":"<what changed>","fixedFiles":[{"path":"...","content":"..."}]}`;

  onLog?.(`[AI] Exception: ${params.exceptionType} | Module: ${params.faultingModule}`);
  onLog?.(`[AI] CDB file : ${params.cdbTxtPath || '(none)'}`);
  onLog?.(`[AI] Stack    : ${params.callStack.split('\n').filter(Boolean).length} lines`);
  onLog?.(`[AI] Sources  : ${params.sourceFiles.length} file(s) — ${params.sourceFiles.map(f => f.path).join(', ') || '(none)'}`);
  onLog?.(`[AI] Prompt   : ${prompt.length} chars`);
  onLog?.(`[AI] ── Prompt ─────────────────────`);
  for (const line of prompt.split('\n')) onLog?.(line);
  onLog?.(`[AI] ────────────────────────────────`);
  onLog?.(`[AI] Sending to claude CLI...`);

  const text = await runClaude(prompt);
  onLog?.(`[AI] Response received — ${text.length} chars`);

  try {
    const result = JSON.parse(text.trim());
    const fixedFiles: FixedFile[] = (result.fixedFiles || []).map((f: any) => {
      const original = params.sourceFiles.find((s) => s.path === f.path)?.content || '';
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
