import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import AdmZip from 'adm-zip';
import { loadConfig } from './config';
import { getCurrentPlatform } from './config';

/**
 * Prepares a local working directory for this software version's crash dumps.
 * Dump files are downloaded from the crash report's fileLink (dumpUrl) in the next step.
 * Returns the local directory path.
 */
export async function downloadPdbFiles(
  softwareId: number,
  swVersion: string,
  onLog?: (line: string) => void
): Promise<string> {
  const config = loadConfig();
  const localBaseDir = config.releaseBuildBaseDir;
  if (!localBaseDir) throw new Error('Local Extract Directory is not configured in Settings.');

  const workDir = path.join(localBaseDir, String(softwareId), swVersion);
  if (!fs.existsSync(workDir)) {
    fs.mkdirSync(workDir, { recursive: true });
    onLog?.(`Created work directory: ${workDir}`);
  } else {
    onLog?.(`Using existing directory: ${workDir}`);
  }

  return workDir;
}

/**
 * Downloads a crash dump zip from the given URL.
 * - Extracts all zip contents into {pdbDir}/{crashId}/
 * - Copies the .dmp file to {pdbDir}/ (alongside PDB files, for CDB analysis)
 * Skips if .dmp already present in pdbDir. Returns the path of the .dmp in pdbDir.
 */
export async function downloadDump(
  crashId: string,
  dumpUrl: string,
  pdbDir: string,
  onLog?: (line: string) => void
): Promise<string> {
  // Check if already copied to pdbDir root
  const existingDmp = fs.existsSync(pdbDir)
    ? fs.readdirSync(pdbDir).find((f) => f.endsWith('.dmp') && f.includes(String(crashId)))
    : undefined;
  if (existingDmp) {
    const dmpPath = path.join(pdbDir, existingDmp);
    onLog?.(`Already downloaded: ${dmpPath}`);
    return dmpPath;
  }

  const crashDir = path.join(pdbDir, String(crashId));
  fs.mkdirSync(crashDir, { recursive: true });

  const zipPath = path.join(crashDir, 'dump.zip');
  const cleanUrl = dumpUrl.replace(/\[/g, '').replace(/\]/g, '').replace(/月/g, '%e6%9c%88');

  onLog?.(`> Downloading: ${cleanUrl}`);
  onLog?.(`  → ${zipPath}`);
  await downloadFile(cleanUrl, zipPath, onLog);

  // Extract entire zip into crashDir
  onLog?.(`> Extracting zip contents...`);
  onLog?.(`  → ${crashDir}`);
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(crashDir, true);
  fs.unlinkSync(zipPath);

  // Find the .dmp file inside crashDir (may be in a subfolder)
  const dmpEntry = zip.getEntries().find((e) => e.entryName.endsWith('.dmp'));
  if (!dmpEntry) throw new Error('No .dmp file found in downloaded zip.');
  const dmpFilename = path.basename(dmpEntry.entryName);
  const dmpInCrashDir = path.join(crashDir, dmpFilename);

  // Copy .dmp to pdbDir root so CDB can find it alongside PDB files
  const dmpInPdbDir = path.join(pdbDir, `${crashId}_${dmpFilename}`);
  onLog?.(`> Copying .dmp to PDB directory...`);
  onLog?.(`  ${dmpInCrashDir} → ${dmpInPdbDir}`);
  fs.copyFileSync(dmpInCrashDir, dmpInPdbDir);

  return dmpInPdbDir;
}

/**
 * Extract a zip file using system tools to support files > 2GB.
 * Windows: uses tar.exe (built-in on Windows 10+), falls back to PowerShell Expand-Archive.
 * macOS/Linux: uses unzip.
 */
function extractLargeZip(zipPath: string, destDir: string, onLog?: (line: string) => void): void {
  const platform = getCurrentPlatform();

  if (platform === 'macos') {
    onLog?.(`> unzip "${zipPath}" -d "${destDir}"`);
    execSync(`unzip -o "${zipPath}" -d "${destDir}"`, {
      encoding: 'utf-8',
      timeout: 600000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return;
  }

  // Windows: use PowerShell Expand-Archive (handles UNC paths and files > 2GB)
  const ps = `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`;
  onLog?.(`> powershell Expand-Archive "${zipPath}" → "${destDir}"`);
  execSync(`powershell -NoProfile -Command "${ps}"`, {
    encoding: 'utf-8',
    timeout: 600000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

function downloadFile(url: string, dest: string, onLog?: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const client = url.startsWith('https') ? https : http;

    (client as typeof https).get(url, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        file.close();
        fs.unlinkSync(dest);
        onLog?.(`  Redirect → ${response.headers.location}`);
        downloadFile(response.headers.location, dest, onLog).then(resolve).catch(reject);
        return;
      }
      if (response.statusCode !== 200) {
        file.close();
        reject(new Error(`HTTP ${response.statusCode} downloading dump file`));
        return;
      }
      response.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
    }).on('error', (err) => {
      file.close();
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

// ── Windows: CDB auto-install via winget ──
async function installCdbViaWinget(onLog?: (line: string) => void): Promise<boolean> {
  return new Promise((resolve) => {
    // Check winget is available
    try {
      execSync('winget --version', { encoding: 'utf-8', timeout: 5000 });
    } catch {
      onLog?.('[CDB] winget not found — cannot auto-install. Please install Windows Debugging Tools manually.');
      resolve(false);
      return;
    }

    onLog?.('[CDB] CDB not found. Installing Windows Debugging Tools via winget...');
    onLog?.('[CDB] This may take several minutes and requires an internet connection.');
    onLog?.('[CDB] Running: winget install --id Microsoft.WindowsSDK.10.0.18362 --silent --accept-package-agreements --accept-source-agreements');

    const proc = spawn('winget', [
      'install',
      '--id', 'Microsoft.WindowsSDK.10.0.18362',
      '--silent',
      '--accept-package-agreements',
      '--accept-source-agreements',
    ], { windowsHide: false });

    proc.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      for (const line of text.split(/\r?\n/)) {
        const t = line.trim();
        if (t) onLog?.(`[winget] ${t}`);
      }
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      for (const line of text.split(/\r?\n/)) {
        const t = line.trim();
        if (t) onLog?.(`[winget] ${t}`);
      }
    });

    proc.on('close', (code) => {
      if (code === 0) {
        onLog?.('[CDB] Installation complete.');
        resolve(true);
      } else {
        onLog?.(`[CDB] winget exited with code ${code}. Installation may have failed or requires admin rights.`);
        resolve(false);
      }
    });

    proc.on('error', (err) => {
      onLog?.(`[CDB] Failed to launch winget: ${err.message}`);
      resolve(false);
    });
  });
}

// ── Windows: CDB analysis ──
// Default CDB path installed by Windows SDK / WinDbg
const DEFAULT_CDB_PATH = 'C:\\Program Files (x86)\\Windows Kits\\10\\Debuggers\\x64\\cdb.exe';

async function analyzeDumpWindows(
  dumpPath: string,
  pdbDir: string,
  onLog?: (line: string) => void
): Promise<string> {
  // Re-read config after potential install so cdbPath is up-to-date
  let cfg = loadConfig();
  let cdbPath = cfg.debugger.windows.cdbPath || DEFAULT_CDB_PATH;

  if (!fs.existsSync(cdbPath)) {
    const installed = await installCdbViaWinget(onLog);
    cfg = loadConfig(); // re-read in case user updated path during install
    cdbPath = cfg.debugger.windows.cdbPath || DEFAULT_CDB_PATH;
    if (!installed || !fs.existsSync(cdbPath)) {
      throw new Error(
        `CDB not found at: ${cdbPath}\n` +
        `Auto-install failed or was cancelled.\n` +
        `Please install manually: winget install Microsoft.WindowsSDK.10.0.18362\n` +
        `Then update the CDB path in Settings.`
      );
    }
  }

  const { symbolPath } = cfg.debugger.windows;

  return new Promise((resolve, reject) => {

    // Symbol path: local PDBs first, then MS public symbol server with local cache.
    // C:\Symbols acts as a local cache — ntdll.pdb etc. are downloaded once and reused.
    const msSymSrv = 'srv*C:\\Symbols*https://msdl.microsoft.com/download/symbols';
    const symParts = [pdbDir, symbolPath || '', msSymSrv].filter(Boolean);
    const symPath = symParts.join(';');

    // CDB output txt path (same folder as dump, named after crashId)
    const dmpBase = path.basename(dumpPath, '.dmp');
    const txtPath = path.join(pdbDir, `${dmpBase}_cdb.txt`);

    const commands = [
      '.reload /f',
      '!analyze -v',
      '.ecxr',
      'kb 50',
      'dv',
      'r',
      'q',
    ].join('; ');

    onLog?.(`> Running CDB: "${cdbPath}"`);
    onLog?.(`  dump: "${dumpPath}"`);
    onLog?.(`  symbols: "${symPath}"`);

    // Use -y flag for symbol path (cleaner than .sympath command)
    const proc = spawn(cdbPath, [
      '-z', dumpPath,
      '-y', symPath,
      '-lines',   // include source line numbers if available
      '-nosqm',   // disable SQM (no Microsoft telemetry calls)
      '-c', commands,
    ], { windowsHide: true });

    const outputLines: string[] = [];

    const handleChunk = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      const lines = text.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trimEnd();
        if (trimmed) {
          outputLines.push(trimmed);
          onLog?.(trimmed);
        }
      }
    };

    proc.stdout.on('data', handleChunk);
    proc.stderr.on('data', handleChunk);

    proc.on('close', () => {
      const output = outputLines.join('\n');
      // Save full CDB output to txt file
      try {
        fs.writeFileSync(txtPath, output, 'utf-8');
        onLog?.(`  Saved CDB output → ${txtPath}`);
      } catch {
        // non-fatal
      }
      resolve(output);
    });
    proc.on('error', reject);

    // Safety timeout: 15 minutes (first run may download ntdll.pdb ~20MB from MS symbol server)
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('CDB analysis timed out after 15 minutes'));
    }, 900000);
    proc.on('close', () => clearTimeout(timer));
  });
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

  const cmdFile = path.join(path.dirname(dumpPath), `lldb_cmd_${Date.now()}.txt`);
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

export function analyzeDump(
  dumpPath: string,
  pdbDir: string,
  onLog?: (line: string) => void
): Promise<string> {
  const platform = getCurrentPlatform();
  return platform === 'macos'
    ? Promise.resolve(analyzeDumpMacos(dumpPath))
    : analyzeDumpWindows(dumpPath, pdbDir, onLog);
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
