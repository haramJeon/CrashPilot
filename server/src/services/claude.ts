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
  sourceFiles: { path: string; content: string }[];
}): Promise<{
  rootCause: string;
  suggestedFix: string;
  fixedFiles: FixedFile[];
}> {
  const sourceContext = params.sourceFiles
    .map((f) => `--- ${f.path} ---\n${f.content}`)
    .join('\n\n');

  const prompt = `You are a crash dump analysis expert. Analyze this crash and provide a fix.

## Exception Info
- Type: ${params.exceptionType}
- Message: ${params.exceptionMessage}
- Faulting Module: ${params.faultingModule}

## Call Stack
${params.callStack}

## Related Source Files
${sourceContext}

## Instructions
1. Analyze the root cause of this crash
2. Provide a clear explanation
3. Generate the fixed source code

Respond in this exact JSON format:
{
  "rootCause": "Clear explanation of why the crash happened",
  "suggestedFix": "Description of the fix applied",
  "fixedFiles": [
    {
      "path": "relative/path/to/file.cpp",
      "content": "full fixed file content"
    }
  ]
}

IMPORTANT: Return ONLY valid JSON, no markdown code blocks.`;

  const text = await runClaude(prompt);

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

    return {
      rootCause: result.rootCause || 'Analysis failed',
      suggestedFix: result.suggestedFix || '',
      fixedFiles,
    };
  } catch {
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
