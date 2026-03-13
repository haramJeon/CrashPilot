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
 * Matches if the ref contains the version (or major.minor.patch part of it).
 */
export function findMatchingRefs(refs: RemoteRef[], swVersion: string): RemoteRef[] {
  if (!swVersion) return [];

  const parts = swVersion.split('.');
  // Try exact match, then major.minor.patch, then major.minor
  const candidates = [
    swVersion,
    parts.slice(0, 3).join('.'),
    parts.slice(0, 2).join('.'),
  ].filter(Boolean);

  return refs.filter((ref) =>
    candidates.some((v) => ref.short.includes(v))
  );
}

/**
 * Convert branch name to a safe folder name.
 * e.g. "release/2.1.3" → "release_2.1.3"
 */
function branchToFolder(branch: string): string {
  return branch.replace(/[\/\\:*?"<>|]/g, '_');
}

/**
 * Returns the local repo path for a given branch.
 * Creates repoBaseDir if it doesn't exist.
 */
export function getRepoDirForBranch(branch: string): string {
  const config = loadConfig();
  const baseDir = config.git.repoBaseDir;
  if (!baseDir) throw new Error('Git repoBaseDir is not configured in Settings.');
  const repoDir = path.join(baseDir, branchToFolder(branch));
  return repoDir;
}

/**
 * Ensures a local clone exists for the given branch.
 * - If folder doesn't exist: clone with --single-branch for that branch
 * - If folder exists: pull latest
 * Returns the local repo path.
 */
export async function checkoutBranch(branch: string): Promise<string> {
  const config = loadConfig();
  const repoUrl = config.git.repoUrl;
  if (!repoUrl) throw new Error('Git repoUrl is not configured in Settings.');

  const repoDir = getRepoDirForBranch(branch);

  if (!fs.existsSync(repoDir)) {
    console.log(`[git] Cloning ${repoUrl} branch "${branch}" into ${repoDir}...`);
    fs.mkdirSync(repoDir, { recursive: true });
    try {
      await simpleGit().clone(repoUrl, repoDir, [
        '--branch', branch,
        '--single-branch',
        '--depth', '10',
      ]);
    } catch (err: any) {
      // Remove partial clone on failure
      fs.rmSync(repoDir, { recursive: true, force: true });
      throw new Error(`Failed to clone branch "${branch}": ${err.message}`);
    }
  } else {
    console.log(`[git] Pulling latest for branch "${branch}" in ${repoDir}...`);
    const git = simpleGit(repoDir);
    await git.pull('origin', branch);
  }

  return repoDir;
}

export async function createFixBranch(
  baseBranch: string,
  crashId: string
): Promise<{ branchName: string; repoDir: string }> {
  const repoDir = getRepoDirForBranch(baseBranch);
  const git = simpleGit(repoDir);
  const branchName = `fix/crash-${crashId}-${Date.now()}`;
  await git.checkoutBranch(branchName, `origin/${baseBranch}`);
  return { branchName, repoDir };
}

export async function applyFixes(repoDir: string, fixedFiles: FixedFile[]): Promise<void> {
  for (const file of fixedFiles) {
    const fullPath = path.join(repoDir, file.path);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(fullPath, file.modified, 'utf-8');
  }
}

export async function commitAndPush(
  repoDir: string,
  fixedFiles: FixedFile[],
  message: string
): Promise<void> {
  const git = simpleGit(repoDir);
  for (const file of fixedFiles) {
    await git.add(file.path);
  }
  await git.commit(message);
  const branch = (await git.branch()).current;
  await git.push('origin', branch, ['--set-upstream']);
}

export async function getSourceFiles(
  repoDir: string,
  filePaths: string[]
): Promise<{ path: string; content: string }[]> {
  const results: { path: string; content: string }[] = [];
  for (const filePath of filePaths) {
    const fullPath = path.join(repoDir, filePath);
    if (fs.existsSync(fullPath)) {
      results.push({ path: filePath, content: fs.readFileSync(fullPath, 'utf-8') });
    }
  }
  return results;
}
