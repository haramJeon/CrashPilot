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


/**
 * Find the remote branch whose HEAD is closest (fewest commits ahead) to the given tag.
 * Uses GitHub API compare endpoint — works with shallow clones.
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

    // Only consider release/ branches
    const releaseBranches = branches.filter(b => b.name.startsWith('release/'));

    // Keyword derived from swName for branch name matching
    // e.g. "APOS Touch" → ["apos", "touch"], require at least one word to match
    const swKeywords = swName
      ? swName.toLowerCase().split(/[\s\-_]+/).filter(w => w.length > 1)
      : [];

    const candidates: { name: string; aheadBy: number; swMatch: boolean }[] = [];

    for (const branch of releaseBranches) {
      // If swName provided, skip branches that don't contain any keyword
      const lowerName = branch.name.toLowerCase();
      const swMatch = swKeywords.length > 0 && swKeywords.some(kw => lowerName.includes(kw));
      if (swKeywords.length > 0 && !swMatch) continue;

      try {
        const { data } = await octokit.repos.compareCommitsWithBasehead({
          owner,
          repo,
          basehead: `${tag}...${branch.name}`,
        });
        // Only consider branches that contain the tag commit
        if (data.status === 'ahead' || data.status === 'identical') {
          candidates.push({ name: branch.name, aheadBy: data.ahead_by, swMatch });
        }
      } catch { /* branch may not contain tag — skip */ }
    }

    if (candidates.length === 0) return null;

    // Sort by fewest commits ahead (all candidates already match swName if provided)
    candidates.sort((a, b) => a.aheadBy - b.aheadBy);

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

### Changed Files
${params.analysis.fixedFiles.map((f) => `- \`${f.path}\``).join('\n')}

### Diff
\`\`\`diff
${params.analysis.fixedFiles.map((f) => f.diff).join('\n\n')}
\`\`\`

---
> Auto-generated by **CrashPilot** using Claude AI analysis
`;

  const prUrls: string[] = [];

  // ── Collect repos that need PRs ─────────────────────────────────────────
  const targets: { owner: string; repo: string; dir: string; submoduleBranch?: string | null }[] = [];

  // Parent repo: derive owner/repo from config or repoUrl
  const parentUrl = config.git.repoUrl || '';
  const parentParsed = parseGitHubOwnerRepo(parentUrl);

  if (parentParsed) {
    targets.push({ ...parentParsed, dir: params.repoDir || '' });
  }

  // Submodule repos: find submodules that contain changed files
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

  // ── Resolve base branch from Settings mapping ────────────────────────────
  const map = loadTagBranchMap();
  const resolvedBase = map[params.baseBranch];
  if (!resolvedBase) {
    throw new Error(
      `No branch mapping found for tag "${params.baseBranch}". ` +
      `Please add it in Settings → Tag → Branch Mapping.`
    );
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
