import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import yauzl from 'yauzl';
import { loadConfig } from './config';
import { getAppRoot } from '../utils/appPaths';

/**
 * Ensures the release build zip is extracted locally (PDB / symbol files).
 *
 * Windows:
 *   Network zip : {buildNetworkBaseDir}/{softwareBuildPath}/{major.minor.patch}/Windows/Build/{version}_Release.zip
 *   Extracted to: {releaseBuildBaseDir}/{appFolder}/Windows/{version}_Release/
 *
 * macOS:
 *   Network zip : {buildNetworkBaseDir}/{softwareBuildPath}/{major.minor.patch}/macOS/Build/{version}-mac-release-sym.zip
 *   Extracted to: {releaseBuildBaseDir}/{appFolder}/macOS/{major.minor.patch}/
 *
 * Returns the local extract directory path.
 */
export async function downloadPdbFiles(
  softwareId: number,
  swVersion: string,
  osType: 'windows' | 'macos' = 'windows',
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
  const majorMinorPatch = swVersion.split('.').slice(0, 3).join('.');

  // OS-specific paths (same networkBase, same softwarePath, version differs only in OS subfolder):
  // Windows: {networkBase}/{softwarePath}/{M.m.p}/Windows/Build/{swVersion}_Release.zip
  // macOS:   {networkBase}/{softwarePath}/{M.m.p}/macOS/Build/{swVersion}-mac-release-sym.zip
  const osFolderName = osType === 'macos' ? 'macOS' : 'Windows';
  const extractDirName = osType === 'macos' ? majorMinorPatch : `${swVersion}_Release`;
  const zipName = osType === 'macos'
    ? `${swVersion}-mac-release-sym.zip`
    : `${swVersion}_Release.zip`;
  const zipNetworkPath = osType === 'macos'
    ? path.join(networkBase, softwarePath, majorMinorPatch, 'macOS', 'Build', zipName)
    : path.join(networkBase, softwarePath, majorMinorPatch, 'Windows', 'Build', zipName);
  const extractDir = path.join(localBaseDir, appFolder, osFolderName, extractDirName);

  const alreadyExtracted = fs.existsSync(extractDir) &&
    fs.readdirSync(extractDir).some(f => !fs.statSync(path.join(extractDir, f)).isDirectory());

  if (alreadyExtracted) {
    onLog?.(`Already extracted: ${extractDir}`);
  } else {
    const localAppDir = path.join(localBaseDir, appFolder, osFolderName);
    const localZipPath = path.join(localAppDir, zipName);
    fs.mkdirSync(localAppDir, { recursive: true });
    onLog?.(`> Copying zip from network...`);
    onLog?.(`  ${zipNetworkPath}`);
    onLog?.(`  → ${localZipPath}`);
    await copyFileAsync(zipNetworkPath, localZipPath, onLog);
    onLog?.(`  Copy done.`);

    onLog?.(`> Extracting...`);
    onLog?.(`  ${localZipPath} → ${extractDir}`);
    fs.mkdirSync(extractDir, { recursive: true });
    await extractZip(localZipPath, extractDir, onLog);

    fs.unlinkSync(localZipPath);
    onLog?.(`  Done — ${osFolderName} symbols available at ${extractDir}`);
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
  const extractedFiles = await extractZip(zipPath, crashDir, onLog);
  fs.unlinkSync(zipPath);

  // Find the .dmp file inside crashDir (may be in a subfolder)
  const dmpEntry = extractedFiles.find((f) => f.endsWith('.dmp'));
  if (!dmpEntry) throw new Error('No .dmp file found in downloaded zip.');
  const dmpFilename = path.basename(dmpEntry);
  const dmpInCrashDir = path.join(crashDir, dmpFilename);

  // Copy .dmp to pdbDir root so CDB can find it alongside PDB files
  const dmpInPdbDir = path.join(pdbDir, `${crashId}_${dmpFilename}`);
  onLog?.(`> Copying .dmp to PDB directory...`);
  onLog?.(`  ${dmpInCrashDir} → ${dmpInPdbDir}`);
  fs.copyFileSync(dmpInCrashDir, dmpInPdbDir);

  return dmpInPdbDir;
}

/**
 * Copy a file asynchronously using streams (avoids blocking the event loop).
 */
function copyFileAsync(src: string, dest: string, onLog?: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const readStream = fs.createReadStream(src);
    const writeStream = fs.createWriteStream(dest);
    readStream.on('error', reject);
    writeStream.on('error', reject);
    writeStream.on('finish', resolve);
    readStream.pipe(writeStream);
  });
}

/**
 * Extract a zip file using yauzl (streaming, no 2 GiB limit, cross-platform).
 * Returns the list of extracted file paths (relative entry names).
 */
function extractZip(zipPath: string, destDir: string, onLog?: (line: string) => void): Promise<string[]> {
  return new Promise((resolve, reject) => {
    onLog?.(`> Extracting with yauzl...`);
    const extractedFiles: string[] = [];

    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) return reject(new Error(`Extraction failed: ${err?.message}`));

      zipfile.readEntry();

      zipfile.on('entry', (entry) => {
        const entryPath = path.join(destDir, entry.fileName);

        if (/\/$/.test(entry.fileName)) {
          // Directory entry
          fs.mkdirSync(entryPath, { recursive: true });
          zipfile.readEntry();
        } else {
          fs.mkdirSync(path.dirname(entryPath), { recursive: true });
          zipfile.openReadStream(entry, (streamErr, readStream) => {
            if (streamErr || !readStream) return reject(new Error(`Extraction failed: ${streamErr?.message}`));
            const writeStream = fs.createWriteStream(entryPath);
            writeStream.on('finish', () => {
              extractedFiles.push(entry.fileName);
              zipfile.readEntry();
            });
            writeStream.on('error', reject);
            readStream.on('error', reject);
            readStream.pipe(writeStream);
          });
        }
      });

      zipfile.on('end', () => {
        onLog?.(`  Done.`);
        resolve(extractedFiles);
      });

      zipfile.on('error', (e) => reject(new Error(`Extraction failed: ${e.message}`)));
    });
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

// ── macOS: minidump_stackwalk analysis ──
async function analyzeDumpMacos(
  dumpPath: string,
  symsDir: string,
  onLog?: (line: string) => void
): Promise<string> {
  const isWin = process.platform === 'win32';
  const toolPath = isWin
    ? path.join(getAppRoot(), 'tools', 'win', 'minidump_stackwalk.exe')
    : path.join(getAppRoot(), 'tools', 'mac', 'minidump_stackwalk');

  if (!fs.existsSync(toolPath)) {
    throw new Error(`minidump_stackwalk not found at: ${toolPath}`);
  }

  // The zip extracts with a subdirectory (e.g. modelBuilder-xcode-deploy-sym/).
  // Skip numeric-named dirs (crash ID folders created by downloadDump) and use the symbol subdir.
  const symSubDir = fs.readdirSync(symsDir)
    .filter(name => !/^\d+$/.test(name))
    .map(name => path.join(symsDir, name))
    .find(p => fs.statSync(p).isDirectory());
  const resolvedSymsDir = symSubDir ?? symsDir;

  const dmpBase = path.basename(dumpPath, '.dmp');
  const txtPath = path.join(path.dirname(dumpPath), `${dmpBase}_minidump.txt`);

  return new Promise((resolve, reject) => {
    onLog?.(`> Running minidump_stackwalk: "${toolPath}"`);
    onLog?.(`  dump: "${dumpPath}"`);
    onLog?.(`  symbols: "${resolvedSymsDir}"`);

    // Windows uses minidump_stackwalk.exe (Rust/rust-minidump): positional args, no -s flag.
    // macOS uses the old C++ minidump_stackwalk: requires -s flag before args.
    const args = isWin ? [dumpPath, resolvedSymsDir] : ['-s', dumpPath, resolvedSymsDir];
    const proc = spawn(toolPath, args);

    const outputLines: string[] = [];

    const handleChunk = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      for (const line of text.split(/\r?\n/)) {
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
      try {
        fs.writeFileSync(txtPath, output, 'utf-8');
        onLog?.(`  Saved minidump_stackwalk output → ${txtPath}`);
      } catch { /* non-fatal */ }
      resolve(output);
    });

    proc.on('error', reject);

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('minidump_stackwalk analysis timed out after 5 minutes'));
    }, 300000);
    proc.on('close', () => clearTimeout(timer));
  });
}

export function analyzeDump(
  dumpPath: string,
  symsDir: string,
  osType: 'windows' | 'macos',
  onLog?: (line: string) => void
): Promise<string> {
  return osType === 'macos'
    ? analyzeDumpMacos(dumpPath, symsDir, onLog)
    : analyzeDumpWindows(dumpPath, symsDir, onLog);
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

// ── macOS minidump_stackwalk output parser ──
// Example output:
//   Crash reason:  EXC_BAD_ACCESS / KERN_INVALID_ADDRESS
//   Crash address: 0x0
//   Thread 0 (crashed)
//    0  MarcApp!SomeClass::method() [file.cpp : 42 + 0x3]
//    1  MarcApp!Caller::call()
//   Thread 1
//    0  libsystem_kernel.dylib!mach_msg_trap
function extractCallStackMacos(output: string) {
  const lines = output.split('\n');
  let exceptionType = 'Unknown';
  let exceptionMessage = '';
  let faultingModule = 'Unknown';
  const callStackLines: string[] = [];
  let inCrashedThread = false;

  for (const line of lines) {
    // "Crash reason:  EXC_BAD_ACCESS / KERN_INVALID_ADDRESS"
    if (line.startsWith('Crash reason:')) {
      exceptionType = line.replace('Crash reason:', '').trim();
      continue;
    }
    // "Crash address: 0x..."
    if (line.startsWith('Crash address:')) {
      exceptionMessage = line.trim();
      continue;
    }
    // "Thread 0 (crashed)" → start collecting frames
    if (/^Thread \d+ \(crashed\)/.test(line)) {
      inCrashedThread = true;
      continue;
    }
    // Next "Thread N" without "(crashed)" → stop
    if (/^Thread \d+/.test(line) && inCrashedThread) {
      inCrashedThread = false;
      continue;
    }
    if (inCrashedThread) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      callStackLines.push(trimmed);
      // Extract module from first frame: " 0  ModuleName!FunctionName ..."
      if (faultingModule === 'Unknown') {
        const moduleMatch = trimmed.match(/^\d+\s+(\S+)!/);
        if (moduleMatch) faultingModule = moduleMatch[1];
      }
    }
  }

  return { callStack: callStackLines.join('\n'), exceptionType, exceptionMessage: exceptionMessage.trim(), faultingModule };
}

export function extractCallStack(
  output: string,
  osType: 'windows' | 'macos'
): {
  callStack: string;
  exceptionType: string;
  exceptionMessage: string;
  faultingModule: string;
} {
  return osType === 'macos'
    ? extractCallStackMacos(output)
    : extractCallStackWindows(output);
}
