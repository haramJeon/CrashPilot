import { execSync } from 'child_process';
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
 * Downloads a crash dump zip from the given URL and extracts the .dmp file
 * into {pdbDir}/crashes/{crashId}/.
 * Skips if .dmp already present. Returns the full path to the .dmp file.
 */
export async function downloadDump(
  crashId: string,
  dumpUrl: string,
  pdbDir: string,
  onLog?: (line: string) => void
): Promise<string> {
  const crashDir = path.join(pdbDir, 'crashes', String(crashId));

  // Skip if already downloaded
  if (fs.existsSync(crashDir)) {
    const existing = fs.readdirSync(crashDir).find((f) => f.endsWith('.dmp'));
    if (existing) {
      const dmpPath = path.join(crashDir, existing);
      onLog?.(`Already downloaded: ${dmpPath}`);
      return dmpPath;
    }
  }

  fs.mkdirSync(crashDir, { recursive: true });

  const zipPath = path.join(crashDir, 'dump.zip');
  const cleanUrl = dumpUrl.replace(/\[/g, '').replace(/\]/g, '').replace(/月/g, '%e6%9c%88');

  onLog?.(`> Downloading: ${cleanUrl}`);
  onLog?.(`  → ${zipPath}`);

  await downloadFile(cleanUrl, zipPath, onLog);

  onLog?.(`> Extracting .dmp from zip...`);
  const zip = new AdmZip(zipPath);
  const dmpEntry = zip.getEntries().find((e) => e.entryName.endsWith('.dmp'));
  if (!dmpEntry) throw new Error('No .dmp file found in downloaded zip.');

  const dmpFilename = path.basename(dmpEntry.entryName);
  zip.extractEntryTo(dmpEntry.entryName, crashDir, false, true);
  const dmpPath = path.join(crashDir, dmpFilename);
  onLog?.(`  → ${dmpPath}`);

  fs.unlinkSync(zipPath);
  return dmpPath;
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
