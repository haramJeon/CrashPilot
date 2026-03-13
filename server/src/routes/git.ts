import { Router } from 'express';
import { listRemoteRefs, findMatchingRefs } from '../services/git';

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
