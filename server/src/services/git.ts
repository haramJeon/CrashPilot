import simpleGit from 'simple-git';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { loadConfig } from './config';
import { FixedFile } from '../types';

export interface RemoteRef {
  name: string;   // full ref name, e.g. "refs/heads/release/2.1.3"
  short: string;  // short name, e.g. "release/2.1.3"
  type: 'branch' | 'tag';
}

/**
 * List all remote branches and tags without cloning.
 * Uses: git ls-remote --heads --tags <url>
 */
export async function listRemoteRefs(): Promise<RemoteRef[]> {
  const config = loadConfig();
  const repoUrl = config.git.repoUrl;
  if (!repoUrl) throw new Error('Git repoUrl is not configured.');

  const output = execSync(`git ls-remote --heads --tags "${repoUrl}"`, {
    encoding: 'utf-8',
    timeout: 30000,
  });

  const refs: RemoteRef[] = [];
  for (const line of output.split('\n')) {
    const parts = line.trim().split('\t');
    if (parts.length < 2) continue;
    const ref = parts[1];

    if (ref.startsWith('refs/heads/')) {
      refs.push({ name: ref, short: ref.replace('refs/heads/', ''), type: 'branch' });
    } else if (ref.startsWith('refs/tags/') && !ref.endsWith('^{}')) {
      refs.push({ name: ref, short: ref.replace('refs/tags/', ''), type: 'tag' });
    }
  }
  return refs;
}

/**
 * Find branches/tags that match a given sw_version string.
 * Optionally filter by tagFolder (first segment of tag path).
 */
export function findMatchingRefs(
  refs: RemoteRef[],
  swVersion: string,
  tagFolder?: string
): RemoteRef[] {
  if (!swVersion) return [];

  const parts = swVersion.split('.');
  const candidates = [
    swVersion,
    parts.slice(0, 3).join('.'),
    parts.slice(0, 2).join('.'),
  ].filter(Boolean);

  return refs.filter((ref) => {
    if (tagFolder && ref.type === 'tag') {
      const folder = ref.short.split('/')[0];
      if (folder !== tagFolder) return false;
    }
    return candidates.some((v) => ref.short.includes(v));
  });
}

/**
 * Get unique top-level tag folder names.
 * e.g. tags: ["pos/2.1.3/36", "meditlink/3.0.1/10"] → ["pos", "meditlink"]
 */
export function getTagFolders(refs: RemoteRef[]): string[] {
  const folders = new Set<string>();
  for (const ref of refs) {
    if (ref.type === 'tag') {
      const folder = ref.short.split('/')[0];
      if (folder) folders.add(folder);
    }
  }
  return Array.from(folders).sort();
}

/**
 * Auto-suggest the best tag folder for a software name.
 * Checks if any tag folder is a substring of the software name (case-insensitive), or vice versa.
 */
export function guessTagFolder(folders: string[], softwareName: string): string | null {
  if (!softwareName || folders.length === 0) return folders[0] || null;
  const lower = softwareName.toLowerCase().replace(/[\s_-]/g, '');
  // Exact or substring match
  const match = folders.find((f) => lower.includes(f.toLowerCase()) || f.toLowerCase().includes(lower));
  return match || folders[0];
}

/**
 * Find the best (latest) tag for a given folder + sw_version.
 * Tag format: folder/major.minor.patch/build
 * Returns the tag short name, or null if not found.
 */
export function findBestTag(refs: RemoteRef[], tagFolder: string, swVersion: string): string | null {
  const parts = swVersion.split('.');
  const versionCandidates = [
    swVersion,
    parts.slice(0, 3).join('.'),
    parts.slice(0, 2).join('.'),
  ].filter(Boolean);

  const matching = refs.filter((ref) => {
    if (ref.type !== 'tag') return false;
    const folder = ref.short.split('/')[0];
    if (folder !== tagFolder) return false;
    return versionCandidates.some((v) => ref.short.includes(v));
  });

  if (matching.length === 0) return null;

  // Sort: prefer tag with highest build number (last segment)
  matching.sort((a, b) => {
    const buildA = parseInt(a.short.split('/').pop() || '0');
    const buildB = parseInt(b.short.split('/').pop() || '0');
    return buildB - buildA;
  });

  return matching[0].short;
}

/**
 * Convert a branch/tag ref to a local subfolder path.
 * Tag format "pos/2.2.1/36" → folder "pos/2.2.1.36"
 *   (app folder kept, version + build joined with dot)
 * Branch format "release/2.1.3" → folder "release/2.1.3"
 *   (kept as-is, slashes become path separators)
 * Invalid filesystem chars are replaced with '_'.
 */
function refToFolder(ref: string): string {
  const parts = ref.split('/');
  // Tag pattern: folder / major.minor.patch / build  (3+ segments, last is numeric)
  if (parts.length >= 3 && /^\d+$/.test(parts[parts.length - 1])) {
    const appFolder = parts[0];
    const versionParts = parts.slice(1); // ["2.2.1", "36"]
    return `${appFolder}/${versionParts.join('.')}`.replace(/[\\:*?"<>|]/g, '_');
  }
  // Branch or other: keep slashes as path separators
  return ref.replace(/[\\:*?"<>|]/g, '_');
}

/**
 * Returns the local repo path for a given branch.
 * Creates repoBaseDir if it doesn't exist.
 */
export function getRepoDirForBranch(ref: string): string {
  const config = loadConfig();
  const baseDir = config.git.repoBaseDir;
  if (!baseDir) throw new Error('Git repoBaseDir is not configured in Settings.');
  const repoDir = path.join(baseDir, refToFolder(ref));
  return repoDir;
}

function gitWithLog(baseDir?: string, onLog?: (line: string) => void) {
  const git = baseDir ? simpleGit(baseDir) : simpleGit();
  if (onLog) {
    git.outputHandler((_cmd, stdout, stderr) => {
      const emit = (data: Buffer) => {
        data.toString().split('\n').forEach((l) => {
          const line = l.replace(/\r/g, '').trim();
          if (line) onLog(line);
        });
      };
      stdout.on('data', emit);
      stderr.on('data', emit);
    });
  }
  return git;
}

/**
 * Checkout a branch or tag into a version subfolder.
 * - Branch: clone --branch <name> --single-branch, or pull
 * - Tag: clone --branch <tag> --single-branch (tags work as --branch value)
 */
export async function checkoutRef(ref: string, onLog?: (line: string) => void): Promise<string> {
  const config = loadConfig();
  const repoUrl = config.git.repoUrl;
  if (!repoUrl) throw new Error('Git repoUrl is not configured in Settings.');

  const repoDir = getRepoDirForBranch(ref);

  if (!fs.existsSync(repoDir)) {
    fs.mkdirSync(repoDir, { recursive: true });
    onLog?.(`> git clone --branch ${ref} --single-branch --depth 20 --progress ${repoUrl} ${repoDir}`);
    try {
      await gitWithLog(undefined, onLog).clone(repoUrl, repoDir, [
        '--branch', ref,
        '--single-branch',
        '--depth', '20',
        '--progress',
      ]);
    } catch (err: any) {
      fs.rmSync(repoDir, { recursive: true, force: true });
      throw new Error(`Failed to clone ref "${ref}": ${err.message}`);
    }
  } else {
    onLog?.(`> git fetch origin ${ref} --progress  (in ${repoDir})`);
    await gitWithLog(repoDir, onLog).fetch(['origin', ref, '--progress']);
  }

  return repoDir;
}

/**
 * Run git submodule update --init in the given repo directory.
 */
export async function initSubmodules(repoDir: string, onLog?: (line: string) => void): Promise<void> {
  onLog?.(`> git submodule update --init  (in ${repoDir})`);
  await gitWithLog(repoDir, onLog).submoduleUpdate(['--init']);
}

// Keep old name as alias for backward compat
export const checkoutBranch = checkoutRef;

export async function createFixBranch(
  baseRef: string,
  crashId: string,
  onLog?: (line: string) => void
): Promise<{ branchName: string; repoDir: string }> {
  const repoDir = getRepoDirForBranch(baseRef);
  const git = gitWithLog(repoDir, onLog);

  // Fetch the base ref and reset to a clean state at that commit.
  // This handles re-run: repo may be on an old fix branch with previous changes applied.
  onLog?.(`> git fetch origin ${baseRef}  (in ${repoDir})`);
  await git.fetch(['origin', baseRef]);
  onLog?.(`> git checkout --detach FETCH_HEAD`);
  await git.raw(['checkout', '--detach', 'FETCH_HEAD']);
  onLog?.(`> git reset --hard FETCH_HEAD`);
  await git.raw(['reset', '--hard', 'FETCH_HEAD']);

  const branchName = `fix/crash-${crashId}-${Date.now()}`;
  onLog?.(`> git checkout -b ${branchName}`);
  await git.checkoutBranch(branchName, 'HEAD');
  return { branchName, repoDir };
}

export async function applyFixes(repoDir: string, fixedFiles: FixedFile[], onLog?: (line: string) => void): Promise<void> {
  for (const file of fixedFiles) {
    const fullPath = path.join(repoDir, file.path);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    onLog?.(`Writing fix: ${fullPath}`);
    fs.writeFileSync(fullPath, file.modified, 'utf-8');
  }
}

export async function commitAndPush(
  repoDir: string,
  fixedFiles: FixedFile[],
  message: string,
  onLog?: (line: string) => void
): Promise<void> {
  const git = gitWithLog(repoDir, onLog);
  for (const file of fixedFiles) {
    onLog?.(`> git add ${file.path}`);
    await git.add(file.path);
  }
  const firstLine = message.split('\n')[0];
  onLog?.(`> git commit -m "${firstLine}"`);
  await git.commit(message);
  const branch = (await git.branch()).current;
  onLog?.(`> git push origin ${branch} --set-upstream`);
  await git.push('origin', branch, ['--set-upstream']);
}

const SOURCE_EXTS = new Set(['.cpp', '.h', '.c', '.hpp', '.cc', '.cxx']);
const MAX_FILES_PER_DLL = 8;
const MAX_TOTAL_BYTES = 100_000; // 100 KB total to avoid token overflow

function walkSourceFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        files.push(...walkSourceFiles(path.join(dir, entry.name)));
      } else if (entry.isFile() && SOURCE_EXTS.has(path.extname(entry.name).toLowerCase())) {
        files.push(path.join(dir, entry.name));
      }
    }
  } catch { /* skip inaccessible dirs */ }
  return files;
}

export async function getSourceFiles(
  repoDir: string,
  dllNames: string[]
): Promise<{ path: string; content: string }[]> {
  if (!fs.existsSync(repoDir) || dllNames.length === 0) return [];

  const allFiles = walkSourceFiles(repoDir);
  const seen = new Set<string>();
  const results: { path: string; content: string }[] = [];
  let totalBytes = 0;

  for (const dll of dllNames) {
    const keyword = dll.toLowerCase().replace(/\.dll$/i, '');
    const matched = allFiles
      .filter((f) => {
        const base = path.basename(f, path.extname(f)).toLowerCase();
        const parts = f.toLowerCase().split(/[\\/]/);
        return base.includes(keyword) || parts.some((p) => p.includes(keyword));
      })
      .slice(0, MAX_FILES_PER_DLL);

    for (const fullPath of matched) {
      const relPath = path.relative(repoDir, fullPath).replace(/\\/g, '/');
      if (seen.has(relPath)) continue;
      seen.add(relPath);
      try {
        const content = fs.readFileSync(fullPath, 'utf-8');
        if (totalBytes + content.length > MAX_TOTAL_BYTES) continue;
        totalBytes += content.length;
        results.push({ path: relPath, content });
      } catch { /* skip unreadable */ }
    }
  }

  return results;
}
