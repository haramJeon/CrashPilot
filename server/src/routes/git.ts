import * as fs from 'fs';
import * as path from 'path';
import { Router } from 'express';
import { listRemoteRefs, findMatchingRefs } from '../services/git';
import { findNearestBranchForTag, resolveGitHubToken } from '../services/github';
import { Octokit } from '@octokit/rest';
import { loadConfig } from '../services/config';
import { getAppRoot } from '../utils/appPaths';

const TAG_BRANCH_MAP_PATH = path.join(getAppRoot(), 'data/tag-branch-map.json');

function loadTagBranchMap(): Record<string, string> {
  try {
    if (fs.existsSync(TAG_BRANCH_MAP_PATH)) return JSON.parse(fs.readFileSync(TAG_BRANCH_MAP_PATH, 'utf-8'));
  } catch { }
  return {};
}

function saveTagBranchMap(map: Record<string, string>): void {
  const dir = path.dirname(TAG_BRANCH_MAP_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(TAG_BRANCH_MAP_PATH, JSON.stringify(map, null, 2), 'utf-8');
}

export const gitRouter = Router();

// List all remote branches and tags
gitRouter.get('/refs', async (_req, res) => {
  try {
    const refs = await listRemoteRefs();
    res.json(refs);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Find refs matching a specific sw_version
gitRouter.get('/refs/match', async (req, res) => {
  try {
    const swVersion = String(req.query.version || '');
    const refs = await listRemoteRefs();
    const matches = findMatchingRefs(refs, swVersion);
    res.json(matches);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Get the PR base branch for a tag (from saved map, or auto-detect via GitHub API)
gitRouter.get('/pr-base-branch', async (req, res) => {
  const tag = String(req.query.tag || '');
  if (!tag) return res.status(400).json({ error: 'tag is required' });

  // Check saved mapping first
  const map = loadTagBranchMap();
  if (map[tag]) return res.json({ branch: map[tag], source: 'saved' });

  // Auto-detect via GitHub API
  const config = loadConfig();
  const repoUrl = config.git?.repoUrl || '';
  const m = repoUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
  if (!m) return res.json({ branch: null, source: 'none' });

  const [, owner, repo] = m;
  const octokit = new Octokit({ auth: resolveGitHubToken() });
  const branch = await findNearestBranchForTag(octokit, owner, repo.replace(/\.git$/, ''), tag);
  res.json({ branch, source: branch ? 'detected' : 'none' });
});

// Save a tag → branch mapping
gitRouter.post('/pr-base-branch', (req, res) => {
  const { tag, branch } = req.body;
  if (!tag || !branch) return res.status(400).json({ error: 'tag and branch are required' });
  const map = loadTagBranchMap();
  map[tag] = branch;
  saveTagBranchMap(map);
  res.json({ ok: true, tag, branch });
});

// Get all tag → branch mappings
gitRouter.get('/tag-branch-map', (_req, res) => {
  res.json(loadTagBranchMap());
});

// Delete a tag → branch mapping
gitRouter.delete('/tag-branch-map/:tag', (req, res) => {
  const tag = decodeURIComponent(req.params.tag);
  const map = loadTagBranchMap();
  if (!(tag in map)) return res.status(404).json({ error: 'Mapping not found' });
  delete map[tag];
  saveTagBranchMap(map);
  res.json({ ok: true });
});
