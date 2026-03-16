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
  exceptionMessage: string;
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

  const prompt = `You are a C++ crash dump analysis expert. Your primary task is to trace the call stack to identify the exact crash location in the source code and produce a concrete fix.

## Exception Info
- Type: ${params.exceptionType}
- Message: ${params.exceptionMessage}
- Faulting Module: ${params.faultingModule}
${params.cdbTxtPath ? `- CDB Output File: ${params.cdbTxtPath}` : ''}

## Call Stack (MOST IMPORTANT — start your analysis here)
Trace from the top frame downward to find the first frame that belongs to our source code (not OS/runtime frames).
Identify the exact function, file, and line number where the crash originated.

${params.callStack}

## Related Source Files
Cross-reference the call stack frames against these source files.
Find the function(s) appearing in the call stack and examine the code path that led to the crash.

${sourceContext || '(no source files provided — infer from call stack alone)'}

## Analysis Instructions
1. Find the topmost source-code frame in the call stack (skip ntdll/kernel/runtime frames)
2. Locate that function in the source files above
3. Determine WHY it crashed at that point (null pointer, out-of-bounds, use-after-free, unhandled exception, etc.)
4. Produce the minimal code fix for the identified file(s)
5. Only modify files that directly contain the crashing code path

Respond in this exact JSON format:
{
  "rootCause": "Specific function and reason — e.g. 'ncGeometry::Foo() dereferenced null pointer m_pBar at line 42'",
  "suggestedFix": "Concrete description of what was changed and why",
  "fixedFiles": [
    {
      "path": "relative/path/to/file.cpp",
      "content": "full fixed file content"
    }
  ]
}

IMPORTANT: Return ONLY valid JSON, no markdown code blocks. If you cannot identify a fix with confidence, return an empty fixedFiles array.`;

  // Log summary + full prompt
  onLog?.(`[AI] Exception Type   : ${params.exceptionType}`);
  onLog?.(`[AI] Faulting Module  : ${params.faultingModule}`);
  onLog?.(`[AI] CDB output file  : ${params.cdbTxtPath || '(none)'}`);
  onLog?.(`[AI] Call stack lines : ${params.callStack.split('\n').filter(Boolean).length}`);
  onLog?.(`[AI] Source files     : ${params.sourceFiles.length} file(s) — ${params.sourceFiles.map(f => f.path).join(', ') || '(none)'}`);
  onLog?.(`[AI] Prompt length    : ${prompt.length} chars`);
  onLog?.(`[AI] ── Prompt ──────────────────────────────────`);
  for (const line of prompt.split('\n')) onLog?.(line);
  onLog?.(`[AI] ────────────────────────────────────────────`);
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
