import Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from './config';
import { FixedFile } from '../types';

function getClient(): Anthropic {
  const config = loadConfig();
  return new Anthropic({ apiKey: config.claude.apiKey });
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
  const client = getClient();

  const sourceContext = params.sourceFiles
    .map((f) => `--- ${f.path} ---\n${f.content}`)
    .join('\n\n');

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 8192,
    messages: [
      {
        role: 'user',
        content: `You are a crash dump analysis expert. Analyze this crash and provide a fix.

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

IMPORTANT: Return ONLY valid JSON, no markdown code blocks.`,
      },
    ],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';

  try {
    const result = JSON.parse(text);
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
