/**
 * CrashPilot update checker
 *
 * Compares the current version against the latest GitHub release and returns
 * a download URL so the user can install manually.
 */
import https from 'https';

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

/**
 * Accept "owner/repo", "https://github.com/owner/repo", or
 * "https://github.com/owner/repo.git" and return [owner, repo].
 */
function parseOwnerRepo(input: string): [string, string] | null {
  if (input.startsWith('http://') || input.startsWith('https://')) {
    try {
      const url = new URL(input);
      const parts = url.pathname.replace(/\.git$/, '').split('/').filter(Boolean);
      if (parts.length >= 2) return [parts[0], parts[1]];
      return null;
    } catch { return null; }
  }
  const parts = input.replace(/\.git$/, '').split('/');
  if (parts.length === 2 && parts[0] && parts[1]) return [parts[0], parts[1]];
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export interface UpdateInfo {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion: string;
  downloadUrl?: string;   // direct ZIP asset download URL
  releaseUrl?: string;    // GitHub release HTML page URL
  releaseNotes?: string;
  checkedAt: string;
}

/** Check GitHub releases for a newer version. Throws on network / API error. */
export async function checkForUpdates(
  githubRepo: string,
  githubToken?: string,
): Promise<UpdateInfo> {
  const ownerRepo = parseOwnerRepo(githubRepo);
  if (!ownerRepo) throw new Error(`Invalid githubRepo format: "${githubRepo}" — expected "owner/repo" or a GitHub URL`);
  const [owner, repo] = ownerRepo;

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
    releaseUrl: typeof data.html_url === 'string' ? data.html_url : undefined,
    releaseNotes: typeof data.body === 'string' ? data.body.slice(0, 800) : undefined,
    checkedAt: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────────

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
