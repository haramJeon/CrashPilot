import simpleGit, { SimpleGit } from 'simple-git';
import fs from 'fs';
import path from 'path';
import { loadConfig } from './config';
import { FixedFile } from '../types';

function getGit(): SimpleGit {
  const config = loadConfig();
  return simpleGit(config.git.repoPath);
}

export async function checkoutBranch(branch: string): Promise<void> {
  const git = getGit();
  await git.fetch(['--all']);

  // Check if branch exists locally
  const localBranches = await git.branchLocal();
  if (localBranches.all.includes(branch)) {
    await git.checkout(branch);
    await git.pull('origin', branch);
    return;
  }

  // Try to track from remote
  const remoteBranch = `origin/${branch}`;
  const allBranches = await git.branch(['-a']);
  const remoteExists = allBranches.all.some(
    (b) => b.trim() === `remotes/${remoteBranch}` || b.trim() === remoteBranch
  );

  if (!remoteExists) {
    const available = allBranches.all
      .filter((b) => b.includes('remotes/origin/'))
      .map((b) => b.trim())
      .join('\n');
    throw new Error(`Branch "${branch}" not found.\nAvailable remote branches:\n${available}`);
  }

  await git.checkout(['-b', branch, '--track', remoteBranch]);
}

export async function createFixBranch(baseBranch: string, crashId: string): Promise<string> {
  const git = getGit();
  const branchName = `fix/crash-${crashId}-${Date.now()}`;
  await git.checkoutBranch(branchName, baseBranch);
  return branchName;
}

export async function applyFixes(fixedFiles: FixedFile[]): Promise<void> {
  const config = loadConfig();

  for (const file of fixedFiles) {
    const fullPath = path.join(config.git.repoPath, file.path);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(fullPath, file.modified, 'utf-8');
  }
}

export async function commitAndPush(
  fixedFiles: FixedFile[],
  message: string
): Promise<void> {
  const git = getGit();

  for (const file of fixedFiles) {
    await git.add(file.path);
  }

  await git.commit(message);
  const branch = (await git.branch()).current;
  await git.push('origin', branch, ['--set-upstream']);
}

export async function getSourceFiles(
  filePaths: string[]
): Promise<{ path: string; content: string }[]> {
  const config = loadConfig();
  const results: { path: string; content: string }[] = [];

  for (const filePath of filePaths) {
    const fullPath = path.join(config.git.repoPath, filePath);
    if (fs.existsSync(fullPath)) {
      results.push({
        path: filePath,
        content: fs.readFileSync(fullPath, 'utf-8'),
      });
    }
  }

  return results;
}
