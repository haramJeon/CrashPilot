import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import AdmZip from 'adm-zip';
import { loadConfig } from './config';
import { getCurrentPlatform } from './config';

/**
 * Ensures the release build zip is extracted locally (PDB files).
 * Network zip: {buildNetworkBaseDir}/{softwareBuildPath}/{major.minor.patch}/Windows/Build/{version}_Release.zip
 * Extracted to: {releaseBuildBaseDir}/{version}_Release/
 * Returns the local extract directory path.
 */
export async function downloadPdbFiles(
  softwareId: number,
  swVersion: string,
  onLog?: (line: string) => void
): Promise<string> {
  const config = loadConfig();
  const localBaseDir = config.releaseBuildBaseDir;
  if (!localBaseDir) throw new Error('Release Build Base Directory is not configured in Settings.');

  const networkBase = config.buildNetworkBaseDir;
  const softwarePath = config.softwareBuildPaths?.[String(softwareId)] || '';
  if (!networkBase || !softwarePath) {
    throw new Error(`buildNetworkBaseDir or softwareBuildPaths[${softwareId}] not configured in Settings.`);
  }

  // Use last segment of softwareBuildPaths as app folder name
  // e.g. 'Medit Add-in\\Medit Orthodontic Suite' → 'Medit Orthodontic Suite'
  const appFolder = softwarePath.split(/[/\\]/).filter(Boolean).pop() || String(softwareId);
  const versionReleaseName = `${swVersion}_Release`;
  const extractDir = path.join(localBaseDir, appFolder, versionReleaseName);

  const alreadyExtracted = fs.existsSync(extractDir) &&
    fs.readdirSync(extractDir).some(f => !fs.statSync(path.join(extractDir, f)).isDirectory());

  if (alreadyExtracted) {
    onLog?.(`Already extracted: ${extractDir}`);
  } else {
    const majorMinorPatch = swVersion.split('.').slice(0, 3).join('.');
    const zipNetworkPath = path.join(networkBase, softwarePath, majorMinorPatch, 'Windows', 'Build', `${versionReleaseName}.zip`);

    // Step 1: copy zip from network to local
    const localZipPath = path.join(localBaseDir, appFolder, `${versionReleaseName}.zip`);
    fs.mkdirSync(path.join(localBaseDir, appFolder), { recursive: true });
    onLog?.(`> Copying zip from network...`);
    onLog?.(`  ${zipNetworkPath}`);
    onLog?.(`  → ${localZipPath}`);
    fs.copyFileSync(zipNetworkPath, localZipPath);
    onLog?.(`  Copy done.`);

    // Step 2: extract locally
    onLog?.(`> Extracting...`);
    onLog?.(`  ${localZipPath} → ${extractDir}`);
    fs.mkdirSync(extractDir, { recursive: true });
    extractLargeZip(localZipPath, extractDir, onLog);

    // Step 3: delete local zip
    fs.unlinkSync(localZipPath);
    onLog?.(`  Done — PDB files available at ${extractDir}`);
  }

  return extractDir;
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

// ── Windows: CDB analysis ──
// Default CDB path installed by Windows SDK / WinDbg
const DEFAULT_CDB_PATH = 'C:\\Program Files (x86)\\Windows Kits\\10\\Debuggers\\x64\\cdb.exe';

function analyzeDumpWindows(
  dumpPath: string,
  pdbDir: string,
  onLog?: (line: string) => void
): Promise<string> {
  return new Promise((resolve, reject) => {
    const config = loadConfig();
    const { symbolPath } = config.debugger.windows;
    const cdbPath = config.debugger.windows.cdbPath || DEFAULT_CDB_PATH;

    if (!fs.existsSync(cdbPath)) {
      reject(new Error(
        `CDB not found at: ${cdbPath}\n` +
        `Install Windows Debugging Tools via:\n` +
        `  winget install Microsoft.WindowsSDK.10.0.18362\n` +
        `Default path: ${DEFAULT_CDB_PATH}`
      ));
      return;
    }

    // Symbol path: pdbDir first (local PDBs), then configured path, then MS public symbols
    const symParts = [
      pdbDir,
      symbolPath || '',
      'srv*C:\\Symbols*https://msdl.microsoft.com/download/symbols',
    ].filter(Boolean);
    const symPath = symParts.join(';');

    const commands = [
      `.sympath "${symPath}"`,
      '.reload /f',
      '!analyze -v',
      '.ecxr',
      'kb 50',
      '~*kb',    // all threads call stacks
      'dv',      // local variables at crash frame
      'r',       // registers
      'q',
    ].join('; ');

    onLog?.(`> Running CDB: "${cdbPath}"`);
    onLog?.(`  -z "${dumpPath}"`);
    onLog?.(`  -y "${symPath}"`);

    const proc = spawn(cdbPath, ['-z', dumpPath, '-c', commands], {
      windowsHide: true,
    });

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

    proc.on('close', () => resolve(outputLines.join('\n')));
    proc.on('error', reject);

    // Safety timeout: 3 minutes
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('CDB analysis timed out after 3 minutes'));
    }, 180000);
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
