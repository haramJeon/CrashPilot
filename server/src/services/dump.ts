import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import { loadConfig } from './config';
import { getCurrentPlatform } from './config';

const DUMP_DIR = path.join(__dirname, '../../../dumps');

export async function downloadDump(url: string, filename: string): Promise<string> {
  if (!fs.existsSync(DUMP_DIR)) {
    fs.mkdirSync(DUMP_DIR, { recursive: true });
  }

  const filePath = path.join(DUMP_DIR, filename);

  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(filePath);

    protocol.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        const redirectUrl = response.headers.location;
        if (redirectUrl) {
          file.close();
          fs.unlinkSync(filePath);
          downloadDump(redirectUrl, filename).then(resolve).catch(reject);
          return;
        }
      }

      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve(filePath);
      });
    }).on('error', (err) => {
      fs.unlink(filePath, () => {});
      reject(err);
    });
  });
}

// ── Windows: CDB analysis ──
function analyzeDumpWindows(dumpPath: string): string {
  const config = loadConfig();
  const { cdbPath, symbolPath } = config.debugger.windows;

  if (!fs.existsSync(cdbPath)) {
    throw new Error(`CDB not found at: ${cdbPath}. Install Windows Debugging Tools (Windows SDK).`);
  }

  const commands = [
    `.sympath+ ${symbolPath}`,
    '.reload',
    '!analyze -v',
    'kb',
    '.ecxr',
    'kb',
    'q',
  ].join('; ');

  return execSync(
    `"${cdbPath}" -z "${dumpPath}" -c "${commands}"`,
    { encoding: 'utf-8', timeout: 120000, maxBuffer: 50 * 1024 * 1024 }
  );
}

// ── macOS: lldb analysis ──
function analyzeDumpMacos(dumpPath: string): string {
  const config = loadConfig();
  const { lldbPath, dsymPath } = config.debugger.macos;

  if (!fs.existsSync(lldbPath)) {
    throw new Error(`lldb not found at: ${lldbPath}. Install Xcode Command Line Tools.`);
  }

  // lldb batch commands for crash dump analysis
  const lldbCommands = [
    dsymPath ? `settings set target.debug-file-search-paths "${dsymPath}"` : '',
    'bt all',
    'thread info',
    'register read',
    'quit',
  ].filter(Boolean).join('\n');

  const cmdFile = path.join(DUMP_DIR, `lldb_cmd_${Date.now()}.txt`);
  fs.writeFileSync(cmdFile, lldbCommands, 'utf-8');

  try {
    // Try lldb core dump analysis
    const result = execSync(
      `"${lldbPath}" -c "${dumpPath}" -s "${cmdFile}"`,
      { encoding: 'utf-8', timeout: 120000, maxBuffer: 50 * 1024 * 1024 }
    );
    return result;
  } catch {
    // Fallback: try reading as Apple crash report text format (.crash / .ips)
    try {
      const content = fs.readFileSync(dumpPath, 'utf-8');
      if (content.includes('Thread') && (content.includes('Crashed') || content.includes('Exception'))) {
        return content; // It's a text-based Apple crash report
      }
    } catch { /* binary file, ignore */ }

    throw new Error(`Failed to analyze dump with lldb. Ensure the file is a valid core dump or crash report.`);
  } finally {
    fs.unlinkSync(cmdFile);
  }
}

export function analyzeDump(dumpPath: string): string {
  const platform = getCurrentPlatform();
  return platform === 'macos'
    ? analyzeDumpMacos(dumpPath)
    : analyzeDumpWindows(dumpPath);
}

// ── Windows CDB output parser ──
function extractCallStackWindows(output: string) {
  const lines = output.split('\n');
  let exceptionType = 'Unknown';
  let exceptionMessage = '';
  let faultingModule = 'Unknown';
  const callStackLines: string[] = [];
  let inCallStack = false;

  for (const line of lines) {
    if (line.includes('ExceptionCode:')) {
      exceptionType = line.split(':')[1]?.trim() || exceptionType;
    }
    if (line.includes('EXCEPTION_RECORD:') || line.includes('ExceptionAddress:')) {
      exceptionMessage += line.trim() + '\n';
    }
    if (line.includes('MODULE_NAME:') || line.includes('IMAGE_NAME:')) {
      faultingModule = line.split(':')[1]?.trim() || faultingModule;
    }
    if (line.includes('STACK_TEXT:') || line.includes('Child-SP')) {
      inCallStack = true;
      continue;
    }
    if (inCallStack) {
      if (line.trim() === '' || line.includes('SYMBOL_NAME:')) {
        inCallStack = false;
      } else {
        callStackLines.push(line.trim());
      }
    }
  }

  return { callStack: callStackLines.join('\n'), exceptionType, exceptionMessage: exceptionMessage.trim(), faultingModule };
}

// ── macOS lldb / Apple crash report parser ──
function extractCallStackMacos(output: string) {
  const lines = output.split('\n');
  let exceptionType = 'Unknown';
  let exceptionMessage = '';
  let faultingModule = 'Unknown';
  const callStackLines: string[] = [];
  let inThread = false;
  let foundCrashedThread = false;

  for (const line of lines) {
    // Apple crash report format
    if (line.includes('Exception Type:')) {
      exceptionType = line.split(':').slice(1).join(':').trim();
    }
    if (line.includes('Exception Codes:') || line.includes('Exception Subtype:')) {
      exceptionMessage += line.trim() + '\n';
    }
    if (line.includes('Triggered by Thread:') || line.includes('Crashed Thread:')) {
      exceptionMessage += line.trim() + '\n';
    }

    // lldb backtrace format
    if (line.includes('stop reason =')) {
      exceptionType = line.split('stop reason =')[1]?.trim() || exceptionType;
    }

    // Find crashed thread's call stack
    if (line.match(/^Thread \d+.*Crashed/i) || line.includes('* thread')) {
      foundCrashedThread = true;
      inThread = true;
      continue;
    }
    if (foundCrashedThread && inThread) {
      if (line.match(/^Thread \d+/) || line.trim() === '' || line.includes('Binary Images')) {
        inThread = false;
      } else {
        callStackLines.push(line.trim());
        // Extract module from first frame
        if (faultingModule === 'Unknown') {
          const moduleMatch = line.match(/^\d+\s+(\S+)/);
          if (moduleMatch) faultingModule = moduleMatch[1];
        }
      }
    }

    // lldb frame format: frame #0: 0x... module`function
    if (line.includes('frame #')) {
      callStackLines.push(line.trim());
      if (faultingModule === 'Unknown') {
        const moduleMatch = line.match(/\s(\S+)`/);
        if (moduleMatch) faultingModule = moduleMatch[1];
      }
    }
  }

  return { callStack: callStackLines.join('\n'), exceptionType, exceptionMessage: exceptionMessage.trim(), faultingModule };
}

export function extractCallStack(output: string): {
  callStack: string;
  exceptionType: string;
  exceptionMessage: string;
  faultingModule: string;
} {
  const platform = getCurrentPlatform();
  return platform === 'macos'
    ? extractCallStackMacos(output)
    : extractCallStackWindows(output);
}
