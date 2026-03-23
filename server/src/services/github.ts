import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Octokit } from '@octokit/rest';
import { loadConfig } from './config';
import { CrashAnalysis } from '../types';

import { getAppRoot } from '../utils/appPaths';

const TAG_BRANCH_MAP_PATH = path.join(getAppRoot(), 'data/tag-branch-map.json');
function loadTagBranchMap(): Record<string, string> {
  try {
    if (fs.existsSync(TAG_BRANCH_MAP_PATH)) return JSON.parse(fs.readFileSync(TAG_BRANCH_MAP_PATH, 'utf-8'));
  } catch { }
  return {};
}

/** Get auth token from local git credential manager (same credential git push uses). */
export function resolveGitHubToken(): string {
  try {
    const out = execSync('git credential fill', {
      input: 'protocol=https\nhost=github.com\n',
      encoding: 'utf-8',
      timeout: 5000,
    });
    const m = out.match(/^password=(.+)$/m);
    if (m) return m[1].trim();
  } catch { /* ignore */ }
  return '';
}

function getOctokit(): Octokit {
  return new Octokit({ auth: resolveGitHubToken() });
}

/** Parse { owner, repo } from a GitHub remote URL (https or ssh). */
function parseGitHubOwnerRepo(url: string): { owner: string; repo: string } | null {
  const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
  if (!m) return null;
  return { owner: m[1], repo: m[2].replace(/\.git$/, '') };
}


/** Normalise a string for fuzzy comparison: lowercase + strip non-alphanumeric chars. */
function normStr(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Given a swName and a set of release sub-folder names (the segment right after "release/"),
 * return the folder whose normalised form best matches the normalised swName.
 * Matching order: exact → one contains the other (longer match wins) → highest char overlap.
 */
function bestMatchingSwFolder(swName: string, folders: string[]): string | null {
  if (folders.length === 0) return null;
  const normSw = normStr(swName);
  if (!normSw) return null;

  let best: string | null = null;
  let bestScore = -1;

  for (const folder of folders) {
    const normFolder = normStr(folder);
    if (!normFolder) continue;

    let score = 0;
    if (normFolder === normSw) {
      score = 1000; // exact match
    } else if (normSw.includes(normFolder) || normFolder.includes(normSw)) {
      // one is a substring of the other — prefer the longer overlap
      score = 500 + Math.min(normSw.length, normFolder.length);
    } else {
      // count shared leading characters as a rough similarity measure
      let shared = 0;
      for (let i = 0; i < Math.min(normSw.length, normFolder.length); i++) {
        if (normSw[i] === normFolder[i]) shared++;
        else break;
      }
      score = shared;
    }

    if (score > bestScore) {
      bestScore = score;
      best = folder;
    }
  }

  // Only accept if there is at least some commonality
  return bestScore > 0 ? best : null;
}

/**
 * Find the remote branch whose HEAD is closest (fewest commits ahead) to the given tag.
 * Uses GitHub API compare endpoint — works with shallow clones.
 * Prioritises branches under release/{bestMatchSwFolder}/ first (fuzzy-matched from swName),
 * then any other release/* branch, then everything else.
 * Within each priority group, picks the branch with fewest commits ahead.
 * Limits to first 100 branches to avoid too many API calls.
 */
export async function findNearestBranchForTag(
  octokit: Octokit,
  owner: string,
  repo: string,
  tag: string,
  swName?: string,
): Promise<string | null> {
  try {
    // Paginate branches (cap at 100 to avoid excessive API calls)
    const branches = await octokit.paginate(
      octokit.repos.listBranches,
      { owner, repo, per_page: 100 },
      (res, done) => { done(); return res.data; }
    );

    // Collect unique sub-folder names directly under release/ (e.g. "pos" from "release/pos/2.2.1")
    const releaseFolders = new Set<string>();
    for (const branch of branches) {
      const m = branch.name.match(/^release\/([^/]+)\//i);
      if (m) releaseFolders.add(m[1]);
    }

    // Fuzzy-match swName against available release sub-folders
    const swSegment = swName ? swName.split('/')[0] : null; // first tag segment, e.g. "pos"
    const matchedFolder = swSegment
      ? bestMatchingSwFolder(swSegment, [...releaseFolders])
      : null;
    const releaseSwPrefix = matchedFolder ? `release/${matchedFolder}/`.toLowerCase() : null;

    if (matchedFolder) {
      console.log(`[CrashPilot] swName="${swSegment}" → matched release folder "${matchedFolder}" (prefix: ${releaseSwPrefix})`);
    }

    // priority 0 = release/{matchedFolder}/…  (highest)
    // priority 1 = release/…  (any other release/* branch)
    // Non-release branches are excluded entirely.
    const candidates: { name: string; aheadBy: number; priority: number }[] = [];

    for (const branch of branches) {
      // Only search within release/ branches
      if (!branch.name.toLowerCase().startsWith('release/')) continue;

      try {
        const { data } = await octokit.repos.compareCommitsWithBasehead({
          owner,
          repo,
          basehead: `${tag}...${branch.name}`,
        });
        // Only consider branches that contain the tag commit
        if (data.status === 'ahead' || data.status === 'identical') {
          const lowerName = branch.name.toLowerCase();
          const priority = (releaseSwPrefix && lowerName.startsWith(releaseSwPrefix)) ? 0 : 1;
          candidates.push({ name: branch.name, aheadBy: data.ahead_by, priority });
        }
      } catch { /* branch may not contain tag — skip */ }
    }

    if (candidates.length === 0) return null;

    // Sort: release/{matchedFolder}/ first, then other release/*; within each group fewest ahead
    candidates.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.aheadBy - b.aheadBy;
    });

    return candidates[0].name;
  } catch {
    return null;
  }
}

/** Normalize a file path to repo-relative (forward slashes). */
function toRepoRelative(repoDir: string, filePath: string): string {
  const normalizedFile = filePath.replace(/\\/g, '/');
  const normalizedRepo = repoDir.replace(/\\/g, '/').replace(/\/?$/, '/');
  if (normalizedFile.startsWith(normalizedRepo)) {
    return normalizedFile.slice(normalizedRepo.length);
  }
  return normalizedFile;
}

/** Read submodule entries from .gitmodules (handles CRLF).
 *  Returns a map of submodule path → tracked branch (or null if not specified).
 */
function readSubmoduleEntries(repoDir: string): Map<string, string | null> {
  const file = path.join(repoDir, '.gitmodules');
  if (!fs.existsSync(file)) return new Map();
  const entries = new Map<string, string | null>();
  let currentPath: string | null = null;
  for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
    const pathMatch = line.match(/^\s*path\s*=\s*(.+?)[\r\s]*$/);
    if (pathMatch) {
      currentPath = pathMatch[1].trim();
      if (!entries.has(currentPath)) entries.set(currentPath, null);
    }
    const branchMatch = line.match(/^\s*branch\s*=\s*(.+?)[\r\s]*$/);
    if (branchMatch && currentPath !== null) {
      entries.set(currentPath, branchMatch[1].trim());
    }
  }
  return entries;
}

/** Get the remote origin URL of a git repo / submodule directory. */
function getRemoteUrl(dir: string): string | null {
  try {
    return execSync('git remote get-url origin', { cwd: dir, encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

export async function createPullRequest(params: {
  branch: string;
  baseBranch: string;
  crashSubject: string;
  analysis: CrashAnalysis;
  repoDir?: string;
}): Promise<string> {
  const config = loadConfig();
  const octokit = getOctokit();

  const body = `## Crash Report Auto-Fix

### Exception
- **Type**: ${params.analysis.exceptionType}

### Root Cause
${params.analysis.rootCause}

### Fix Description
${params.analysis.suggestedFix}

---
> Auto-generated by **CrashPilot** using Claude AI analysis
`;

  const prUrls: string[] = [];

  // ── Collect repos that need PRs ─────────────────────────────────────────
  const targets: { owner: string; repo: string; dir: string; submoduleBranch?: string | null }[] = [];

  // Submodule repos: find submodules that contain changed files
  const changedSubmodulePaths = new Set<string>(); // normalized submodule paths that have changes
  if (params.repoDir) {
    const submoduleEntries = readSubmoduleEntries(params.repoDir);
    console.log(`[CrashPilot] Submodule entries in .gitmodules: ${JSON.stringify([...submoduleEntries.entries()])}`);
    console.log(`[CrashPilot] Fixed file paths: ${JSON.stringify(params.analysis.fixedFiles.map((f) => f.path))}`);
    const changedSubmodules = new Map<string, string | null>(); // path → branch
    for (const f of params.analysis.fixedFiles) {
      const norm = toRepoRelative(params.repoDir, f.path);
      console.log(`[CrashPilot] Normalized file path: ${norm}`);
      for (const [sub, branch] of submoduleEntries) {
        const normSub = sub.replace(/\\/g, '/');
        if (norm.startsWith(normSub + '/') || norm === normSub) {
          changedSubmodules.set(sub, branch);
          changedSubmodulePaths.add(normSub);
        }
      }
    }
    console.log(`[CrashPilot] Changed submodules detected: ${JSON.stringify([...changedSubmodules.entries()])}`);
    for (const [sub, subBranch] of changedSubmodules) {
      const subDir = path.join(params.repoDir, sub);
      const subUrl = getRemoteUrl(subDir);
      console.log(`[CrashPilot] Submodule ${sub} → dir=${subDir} url=${subUrl} branch=${subBranch}`);
      if (!subUrl) continue;
      const parsed = parseGitHubOwnerRepo(subUrl);
      if (parsed) targets.push({ ...parsed, dir: subDir, submoduleBranch: subBranch });
    }
  }

  // Parent repo: only add if at least one changed file is NOT inside a submodule
  const hasParentChanges = params.analysis.fixedFiles.some((f) => {
    if (!params.repoDir) return true;
    const norm = toRepoRelative(params.repoDir, f.path);
    return ![...changedSubmodulePaths].some((sub) => norm.startsWith(sub + '/') || norm === sub);
  });
  const parentUrl = config.git.repoUrl || '';
  const parentParsed = parseGitHubOwnerRepo(parentUrl);
  if (parentParsed && hasParentChanges) {
    targets.unshift({ ...parentParsed, dir: params.repoDir || '' });
  } else if (parentParsed && !hasParentChanges) {
    console.log(`[CrashPilot] Skipping parent repo PR — all changes are inside submodules`);
  }

  // ── Resolve base branch: saved mapping → auto-detect nearest release branch ─
  const map = loadTagBranchMap();
  let resolvedBase = map[params.baseBranch];
  if (!resolvedBase) {
    // Extract the sw name from the tag's first path segment (e.g. "pos" from "pos/2.2.1/36")
    const swSegment = params.baseBranch.split('/')[0];
    // Use parent repo for lookup; fall back to first available target repo
    const lookupRepo = parentParsed ?? (targets[0] ? { owner: targets[0].owner, repo: targets[0].repo } : null);
    if (lookupRepo) {
      console.log(`[CrashPilot] No branch mapping for "${params.baseBranch}", auto-detecting nearest release branch (sw=${swSegment})…`);
      resolvedBase = await findNearestBranchForTag(octokit, lookupRepo.owner, lookupRepo.repo, params.baseBranch, swSegment) ?? '';
      if (resolvedBase) {
        console.log(`[CrashPilot] Auto-detected base branch: ${resolvedBase}`);
      }
    }
    if (!resolvedBase) {
      throw new Error(
        `No branch mapping found for tag "${params.baseBranch}" and auto-detection failed. ` +
        `Please add it in Settings → Tag → Branch Mapping.`
      );
    }
  }

  // ── Create a PR for each target repo ────────────────────────────────────
  for (const target of targets) {
    // Submodules use the branch tracked in .gitmodules; parent repo uses the tag→branch mapping
    const base = target.submoduleBranch ?? resolvedBase;

    try {
      console.log(`[CrashPilot] Creating PR: owner=${target.owner} repo=${target.repo} head=${params.branch} base=${base}`);
      const pr = await octokit.pulls.create({
        owner: target.owner,
        repo: target.repo,
        title: `[CrashPilot] Fix: ${params.crashSubject}`,
        body,
        head: params.branch,
        base,
      });
      prUrls.push(pr.data.html_url);
    } catch (err: any) {
      console.error(`[CrashPilot] PR creation failed: owner=${target.owner} repo=${target.repo} head=${params.branch} base=${base} error=${err.message}`);
      prUrls.push(`ERROR creating PR for ${target.owner}/${target.repo}: ${err.message}`);
    }
  }

  if (prUrls.length === 0) throw new Error('No GitHub repos could be determined for PR creation.');
  return prUrls.join('\n');
}
