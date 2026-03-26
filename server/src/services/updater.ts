/**
 * CrashPilot self-updater
 *
 * Flow:
 *  1. checkForUpdates() — compare current version with latest GitHub release
 *  2. downloadUpdate()  — stream ZIP to temp dir with progress callback
 *  3. stageUpdate()     — extract ZIP, copy client/dist in-place, stage new exe as *.new
 *  4. applyUpdate()     — write update script, spawn it detached, exit process
 *
 * Windows update script waits 3 s for the process to die, then renames
 * the old exe and moves the staged .new exe into place, then restarts.
 */
import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import yauzl from 'yauzl';
import { getAppRoot } from '../utils/appPaths';

// Version is read from the server's own package.json (same value as root package.json)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const CURRENT_VERSION: string = (require('../../package.json') as { version: string }).version;
export { CURRENT_VERSION };

// ─────────────────────────────────────────────────────────────────────────────
// Version helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert a GitHub tag like "release/0.9.0/11" → "0.9.0.11"
 * Also handles plain semver tags like "v0.9.0.11" → "0.9.0.11"
 */
function tagToVersion(tag: string): string {
  if (tag.startsWith('release/')) {
    // "release/0.9.0/11" → split → ["release","0.9.0","11"] → join last two
    const parts = tag.slice('release/'.length).split('/');
    return parts.join('.');
  }
  return tag.replace(/^v/, '');
}

/** Returns > 0 if a > b, 0 if equal, < 0 if a < b */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export interface UpdateInfo {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion: string;
  downloadUrl?: string;  // ZIP asset URL (undefined when no update)
  releaseNotes?: string;
  checkedAt: string;
}

/** Check GitHub releases for a newer version. Throws on network / API error. */
export async function checkForUpdates(
  githubRepo: string,
  githubToken?: string,
): Promise<UpdateInfo> {
  const [owner, repo] = githubRepo.split('/');
  if (!owner || !repo) throw new Error(`Invalid githubRepo format: "${githubRepo}" — expected "owner/repo"`);

  const url = `https://api.github.com/repos/${owner}/${repo}/releases/latest`;
  const headers: Record<string, string> = {
    'User-Agent': `CrashPilot/${CURRENT_VERSION}`,
    Accept: 'application/vnd.github+json',
  };
  if (githubToken) headers['Authorization'] = `Bearer ${githubToken}`;

  const data = await fetchJson(url, headers);

  const latestVersion = tagToVersion(data.tag_name ?? '');
  if (!latestVersion) throw new Error(`Cannot parse version from tag: "${data.tag_name}"`);

  const hasUpdate = compareVersions(latestVersion, CURRENT_VERSION) > 0;

  let downloadUrl: string | undefined;
  if (hasUpdate) {
    const assetName = `crashPilot_${latestVersion}.zip`;
    const asset = (data.assets as any[] ?? []).find((a: any) => a.name === assetName);
    downloadUrl = asset?.browser_download_url;
  }

  return {
    hasUpdate,
    currentVersion: CURRENT_VERSION,
    latestVersion,
    downloadUrl,
    releaseNotes: typeof data.body === 'string' ? data.body.slice(0, 800) : undefined,
    checkedAt: new Date().toISOString(),
  };
}

/** Download the update ZIP to a temp directory, reporting progress. Returns the zip path. */
export async function downloadUpdate(
  downloadUrl: string,
  githubToken: string | undefined,
  onProgress: (bytesDownloaded: number, totalBytes: number) => void,
): Promise<string> {
  const tmpDir = path.join(os.tmpdir(), 'crashpilot_update');
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  const zipPath = path.join(tmpDir, 'update.zip');
  const headers: Record<string, string> = { 'User-Agent': `CrashPilot/${CURRENT_VERSION}` };
  if (githubToken) headers['Authorization'] = `Bearer ${githubToken}`;

  await downloadWithProgress(downloadUrl, zipPath, headers, onProgress);
  return zipPath;
}

/**
 * Extract ZIP, copy new client/dist files in-place, stage new exe as *.new.
 * Also writes the platform-specific update script to appRoot.
 */
export async function stageUpdate(zipPath: string, latestVersion: string): Promise<void> {
  const tmpDir = path.dirname(zipPath);
  const extractDir = path.join(tmpDir, 'extracted');
  if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });

  await extractZip(zipPath, extractDir);

  // ZIP contains a top-level folder "crashPilot_{version}/"
  const topLevel = path.join(extractDir, `crashPilot_${latestVersion}`);
  const sourceDir = fs.existsSync(topLevel) ? topLevel : extractDir;

  const appRoot = getAppRoot();

  // ── client/dist: overwrite in-place (server still running — just static files) ──
  const newClientDist = path.join(sourceDir, 'client', 'dist');
  if (fs.existsSync(newClientDist)) {
    const currentClientDist = path.join(appRoot, 'client', 'dist');
    if (fs.existsSync(currentClientDist)) fs.rmSync(currentClientDist, { recursive: true, force: true });
    copyDir(newClientDist, currentClientDist);
  }

  // ── exe: copy as *.new (cannot replace a running exe on Windows) ──
  const exeName = platformExeName();
  const newExeSrc = path.join(sourceDir, exeName);
  const newExeDest = path.join(appRoot, `${exeName}.new`);

  if (fs.existsSync(newExeSrc)) {
    fs.copyFileSync(newExeSrc, newExeDest);
    if (os.platform() !== 'win32') fs.chmodSync(newExeDest, 0o755);
  } else {
    throw new Error(`New executable not found in update package: ${exeName}`);
  }

  // ── write update script ──
  if (os.platform() === 'win32') {
    writeWindowsScript(appRoot, exeName);
  } else {
    writeUnixScript(appRoot, exeName);
  }
}

/**
 * Spawn the update script detached, then exit the process.
 * The script waits for the process to die, swaps the exe, and restarts.
 */
export function applyUpdate(): void {
  const appRoot = getAppRoot();
  const scriptPath = os.platform() === 'win32'
    ? path.join(appRoot, '_update.cmd')
    : path.join(appRoot, '_update.sh');

  if (!fs.existsSync(scriptPath)) throw new Error('Update script not found — run stageUpdate first');

  if (os.platform() === 'win32') {
    spawn('cmd', ['/c', scriptPath], { detached: true, stdio: 'ignore', shell: false }).unref();
  } else {
    spawn('/bin/bash', [scriptPath], { detached: true, stdio: 'ignore' }).unref();
  }

  // Give Socket.IO a moment to send the final event before exiting
  setTimeout(() => process.exit(0), 800);
}

// ─────────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────────

function platformExeName(): string {
  const p = os.platform();
  if (p === 'win32') return 'CrashPilot-win.exe';
  if (p === 'darwin') return os.arch() === 'arm64' ? 'CrashPilot-macos-arm64' : 'CrashPilot-macos-x64';
  return 'CrashPilot-linux-x64';
}

function writeWindowsScript(appRoot: string, exeName: string): void {
  // Wait 3 s for the process to release the exe lock, then rename old → .old, move .new → original, restart
  const script = [
    '@echo off',
    'timeout /t 3 /nobreak > nul',
    `if exist "%~dp0${exeName}.old" del /f /q "%~dp0${exeName}.old"`,
    `rename "%~dp0${exeName}" "${exeName}.old" 2>nul`,
    `move /y "%~dp0${exeName}.new" "%~dp0${exeName}"`,
    `if exist "%~dp0${exeName}.old" del /f /q "%~dp0${exeName}.old"`,
    `start "" "%~dp0${exeName}"`,
    'del "%~f0"',
    '',
  ].join('\r\n');
  fs.writeFileSync(path.join(appRoot, '_update.cmd'), script, 'utf-8');
}

function writeUnixScript(appRoot: string, exeName: string): void {
  const script = [
    '#!/bin/bash',
    `SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"`,
    'sleep 3',
    `mv -f "$SCRIPT_DIR/${exeName}.new" "$SCRIPT_DIR/${exeName}"`,
    `chmod +x "$SCRIPT_DIR/${exeName}"`,
    `"$SCRIPT_DIR/${exeName}" &`,
    'rm -- "$0"',
    '',
  ].join('\n');
  const scriptPath = path.join(appRoot, '_update.sh');
  fs.writeFileSync(scriptPath, script, 'utf-8');
  fs.chmodSync(scriptPath, 0o755);
}

/** Recursively copy a directory */
function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

/** Download a URL to a file, following redirects, reporting progress. */
function downloadWithProgress(
  urlStr: string,
  destPath: string,
  headers: Record<string, string>,
  onProgress: (downloaded: number, total: number) => void,
  redirectCount = 0,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (redirectCount > 10) return reject(new Error('Too many redirects'));
    const urlObj = new URL(urlStr);
    const client = urlObj.protocol === 'https:' ? https : http;
    const req = client.get(urlStr, { headers }, (res) => {
      const status = res.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        const loc = res.headers.location;
        if (!loc) return reject(new Error('Redirect with no Location header'));
        // Drop auth header on cross-origin redirects (CDN)
        const nextHeaders = new URL(loc).host !== urlObj.host
          ? { 'User-Agent': headers['User-Agent'] }
          : headers;
        res.resume(); // consume and discard
        return resolve(downloadWithProgress(loc, destPath, nextHeaders, onProgress, redirectCount + 1));
      }
      if (status !== 200) return reject(new Error(`HTTP ${status} from ${urlStr}`));

      const total = Number(res.headers['content-length'] ?? 0);
      let downloaded = 0;
      const ws = fs.createWriteStream(destPath);

      res.on('data', (chunk: Buffer) => {
        downloaded += chunk.length;
        onProgress(downloaded, total);
      });
      res.pipe(ws);
      ws.on('finish', resolve);
      ws.on('error', reject);
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

/** Extract all entries of a ZIP file to destDir */
function extractZip(zipPath: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipFile) => {
      if (err) return reject(err);
      zipFile.readEntry();
      zipFile.on('entry', (entry) => {
        const destPath = path.join(destDir, entry.fileName);
        if (/\/$/.test(entry.fileName)) {
          fs.mkdirSync(destPath, { recursive: true });
          zipFile.readEntry();
        } else {
          fs.mkdirSync(path.dirname(destPath), { recursive: true });
          zipFile.openReadStream(entry, (err2, readStream) => {
            if (err2) return reject(err2);
            const ws = fs.createWriteStream(destPath);
            readStream.pipe(ws);
            ws.on('finish', () => zipFile.readEntry());
            ws.on('error', reject);
            readStream.on('error', reject);
          });
        }
      });
      zipFile.on('end', resolve);
      zipFile.on('error', reject);
    });
  });
}

/** Simple JSON fetch via https (no fetch polyfill dependency) */
function fetchJson(url: string, headers: Record<string, string>): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        const loc = res.headers.location;
        if (loc) return resolve(fetchJson(loc, headers));
      }
      if ((res.statusCode ?? 0) >= 400) {
        return reject(new Error(`GitHub API returned ${res.statusCode} for ${url}`));
      }
      let body = '';
      res.on('data', (c: Buffer) => { body += c.toString(); });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}
