import { useState, useEffect } from 'react';
import { Save, CheckCircle, AlertCircle, Trash2, Plus } from 'lucide-react';
import { apiGet, apiPost } from '../hooks/useApi';
import type { AppConfig, ApiSoftware, Platform } from '../types';
import './Settings.css';

export default function Settings() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [platform, setPlatform] = useState<Platform>('windows');
  const [softwares, setSoftwares] = useState<ApiSoftware[]>([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [validation, setValidation] = useState<{ valid: boolean; issues: string[] } | null>(null);
  const [tagBranchMap, setTagBranchMap] = useState<Record<string, string>>({});
  const [newTag, setNewTag] = useState('');
  const [newBranch, setNewBranch] = useState('');

  const loadTagBranchMap = () => {
    apiGet<Record<string, string>>('/git/tag-branch-map').then(setTagBranchMap).catch(() => {});
  };

  useEffect(() => {
    const init = async () => {
      try {
        const [data, plat, val] = await Promise.all([
          apiGet<AppConfig>('/config'),
          apiGet<{ platform: Platform }>('/config/platform'),
          apiGet<{ valid: boolean; issues: string[] }>('/config/validate'),
        ]);
        setConfig(data);
        setPlatform(plat.platform);
        setValidation(val);
      } catch (e: unknown) {
        setMessage({ type: 'error', text: e instanceof Error ? e.message : String(e) });
      }
    };
    init();
    apiGet<ApiSoftware[]>('/config/softwares').then(setSoftwares).catch(() => {});
    loadTagBranchMap();
  }, []);

  const addMapping = async () => {
    const tag = newTag.trim();
    const branch = newBranch.trim();
    if (!tag || !branch) return;
    await apiPost('/git/pr-base-branch', { tag, branch }).catch(() => {});
    setNewTag('');
    setNewBranch('');
    loadTagBranchMap();
  };

  const deleteMapping = async (tag: string) => {
    await fetch(`/api/git/tag-branch-map/${encodeURIComponent(tag)}`, { method: 'DELETE' }).catch(() => {});
    loadTagBranchMap();
  };

  const saveSettings = async () => {
    if (!config) return;
    setSaving(true);
    setMessage(null);
    try {
      await apiPost('/config', config);
      setMessage({ type: 'success', text: 'Settings saved successfully' });
      const val = await apiGet<{ valid: boolean; issues: string[] }>('/config/validate');
      setValidation(val);
    } catch (e: unknown) {
      setMessage({ type: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  };

  const update = (section: keyof AppConfig, key: string, value: string) => {
    if (!config) return;
    setConfig({ ...config, [section]: { ...(config[section] as object), [key]: value } });
  };

  if (!config) return <div className="settings-loading">Loading settings...</div>;

  return (
    <div className="settings">
      <div className="page-header">
        <div>
          <h1>Settings</h1>
          <p className="page-subtitle">Configure API keys, paths, and integrations</p>
        </div>
        <button className="btn btn-primary" onClick={saveSettings} disabled={saving}>
          <Save size={16} />
          {saving ? 'Saving...' : 'Save Settings'}
        </button>
      </div>

      {message && (
        <div className={`message message-${message.type}`}>
          {message.type === 'success' ? <CheckCircle size={16} /> : <AlertCircle size={16} />}
          {message.text}
        </div>
      )}

      {validation && !validation.valid && (
        <div className="validation-warnings">
          <h4><AlertCircle size={16} /> Configuration Issues</h4>
          <ul>{validation.issues.map((issue, idx) => <li key={idx}>{issue}</li>)}</ul>
        </div>
      )}

      <div className="settings-grid">
        {/* Release Build */}
        <div className="settings-section">
          <h3>Release Build</h3>
          <div className="field">
            <label>Build Network Base Directory</label>
            <input
              value={config.buildNetworkBaseDir}
              onChange={(e) => setConfig({ ...config, buildNetworkBaseDir: e.target.value })}
              placeholder={platform === 'macos' ? '//10.100.1.20/Build_Repository/Product_Release' : '\\\\10.100.1.20\\Build_Repository\\Product_Release'}
            />
            <p className="field-help">
              UNC path to the product release repo.
              Zip path: <code>{'{base}\\{softwarePath}\\{major.minor.patch}\\Windows\\Build\\{version}_Release.zip'}</code>
            </p>
          </div>
          <div className="field">
            <label>Local Extract Directory</label>
            <input
              value={config.releaseBuildBaseDir}
              onChange={(e) => setConfig({ ...config, releaseBuildBaseDir: e.target.value })}
              placeholder={platform === 'macos' ? '/Users/you/release-builds' : 'D:\\ReleaseCaches'}
            />
            <p className="field-help">
              Zips are extracted here as <code>{'{dir}\\{appFolder}\\{version}_Release\\'}</code>. Crash dumps saved under <code>crashes\{'{crashId}\\'}</code>
            </p>
          </div>
          {softwares.length > 0 && (
            <div className="field">
              <label>Software Build Paths <span className="field-hint">(subfolder under Build Network Base)</span></label>
              {softwares.map((sw) => (
                <div className="tag-folder-row" key={sw.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <span style={{ minWidth: 140, fontSize: 13, color: 'var(--text-secondary)' }}>{sw.name} <span className="field-hint">ID:{sw.id}</span></span>
                  <input
                    style={{ flex: 1 }}
                    value={config.softwareBuildPaths?.[String(sw.id)] ?? ''}
                    onChange={(e) => setConfig({ ...config, softwareBuildPaths: { ...(config.softwareBuildPaths ?? {}), [String(sw.id)]: e.target.value } })}
                    placeholder="Medit Add-in\\Medit Orthodontic Suite"
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Crash Report Server */}
        <div className="settings-section">
          <h3>Crash Report Server</h3>
          <div className="field">
            <label>Server URL</label>
            <input
              value={config.crashReportServer.url}
              onChange={(e) => setConfig({ ...config, crashReportServer: { ...config.crashReportServer, url: e.target.value } })}
              placeholder="http://rnd3.meditlink.com:5001"
            />
            <p className="field-help">Software and date filters are available on the Dashboard.</p>
          </div>
        </div>

        {/* Claude */}
        <div className="settings-section">
          <h3>Claude API</h3>
          <div className="field">
            <label>API Key</label>
            <input type="password" value={config.claude.apiKey} onChange={(e) => update('claude', 'apiKey', e.target.value)} placeholder="sk-ant-..." />
          </div>
          <div className="field">
            <label>Model</label>
            <input value={config.claude.model} onChange={(e) => update('claude', 'model', e.target.value)} placeholder="claude-sonnet-4-6" />
            <p className="field-help">e.g. claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5-20251001</p>
          </div>
        </div>

        {/* GitHub */}
        <div className="settings-section">
          <h3>GitHub</h3>
          <div className="field">
            <label>Personal Access Token</label>
            <input type="password" value={config.github.token} onChange={(e) => update('github', 'token', e.target.value)} placeholder="ghp_..." />
          </div>
          <div className="field">
            <label>Owner (org/user)</label>
            <input value={config.github.owner} onChange={(e) => update('github', 'owner', e.target.value)} placeholder="my-org" />
          </div>
          <div className="field">
            <label>Repository</label>
            <input value={config.github.repo} onChange={(e) => update('github', 'repo', e.target.value)} placeholder="my-repo" />
          </div>
        </div>

        {/* Git */}
        <div className="settings-section">
          <h3>Git Repository</h3>
          <div className="field">
            <label>Repository URL</label>
            <input value={config.git.repoUrl} onChange={(e) => update('git', 'repoUrl', e.target.value)} placeholder="https://github.com/org/repo.git" />
          </div>
          <div className="field">
            <label>Clone Base Directory <span className="field-hint">(each branch cloned into a subfolder here)</span></label>
            <input value={config.git.repoBaseDir} onChange={(e) => update('git', 'repoBaseDir', e.target.value)} placeholder={platform === 'macos' ? '/Users/you/repos/crashpilot' : 'C:\\repos\\crashpilot'} />
            <p className="field-help">
              e.g. base: <code>C:\repos\crashpilot</code> + branch <code>release/2.1.3</code> → <code>C:\repos\crashpilot\release_2.1.3\</code>
            </p>
          </div>
          <div className="field">
            <label>Release Branch Prefix <span className="field-hint">(sw_version to branch mapping)</span></label>
            <input value={config.git.branchPrefix} onChange={(e) => update('git', 'branchPrefix', e.target.value)} placeholder="release/" />
            <p className="field-help">e.g. "release/" + "2.1.3.456" → branch "release/2.1.3"</p>
          </div>
          <div className="field">
            <label>Default Branch <span className="field-hint">(fallback when version is unknown)</span></label>
            <input value={config.git.defaultBranch} onChange={(e) => update('git', 'defaultBranch', e.target.value)} placeholder="master" />
          </div>
        </div>

        {/* Software Tag Folders */}
        <div className="settings-section">
          <h3>Software Tag Folders</h3>
          <p className="field-help" style={{ marginBottom: 14 }}>
            Map each software to its tag root folder in the Git repository.<br />
            e.g. tags like <code>pos/2.1.3/36</code> → folder is <code>pos</code>
          </p>
          {softwares.length === 0 && (
            <p className="field-help">No softwares loaded (check Crash Report Server URL).</p>
          )}
          {softwares.map((sw) => (
            <div className="field tag-folder-row" key={sw.id}>
              <label>{sw.name} <span className="field-hint">ID: {sw.id}</span></label>
              <input
                value={config.git.softwareTagFolders?.[String(sw.id)] ?? ''}
                onChange={(e) => setConfig({
                  ...config,
                  git: {
                    ...config.git,
                    softwareTagFolders: {
                      ...(config.git.softwareTagFolders ?? {}),
                      [String(sw.id)]: e.target.value,
                    },
                  },
                })}
                placeholder="e.g. pos, meditlink"
              />
            </div>
          ))}
        </div>

        {/* Tag → Branch Mapping */}
        <div className="settings-section">
          <h3>Tag → Branch Mapping <span className="field-hint">(used for PR base branch only, does not affect checkout)</span></h3>
          <p className="field-help" style={{ marginBottom: 14 }}>
            When a crash tag matches, the mapped branch is auto-filled as the PR base branch.
          </p>
          {Object.keys(tagBranchMap).length > 0 && (
            <table className="mapping-table">
              <thead>
                <tr><th>Tag</th><th>Branch</th><th></th></tr>
              </thead>
              <tbody>
                {Object.entries(tagBranchMap).map(([tag, branch]) => (
                  <tr key={tag}>
                    <td><code>{tag}</code></td>
                    <td><code>{branch}</code></td>
                    <td>
                      <button className="btn-icon-danger" onClick={() => deleteMapping(tag)} title="Delete">
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="mapping-add-row">
            <input
              className="mapping-input"
              value={newTag}
              onChange={(e) => setNewTag(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addMapping(); }}
              placeholder="tag  (e.g. pos/2.2.1/29)"
            />
            <input
              className="mapping-input"
              value={newBranch}
              onChange={(e) => setNewBranch(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addMapping(); }}
              placeholder="branch  (e.g. release/2.2)"
            />
            <button className="btn btn-sm btn-accent" onClick={addMapping} disabled={!newTag.trim() || !newBranch.trim()}>
              <Plus size={14} /> Add
            </button>
          </div>
        </div>

        {/* Debugger */}
        <div className="settings-section">
          <h3>Debugging Tools <span className="platform-badge">{platform === 'macos' ? 'macOS' : 'Windows'}</span></h3>
          <p className="field-help" style={{ marginBottom: 14 }}>
            Stack traces are pre-loaded from the server. These are used only for raw dump re-analysis.
          </p>
          {platform === 'windows' ? (
            <>
              <div className="field">
                <label>CDB Path</label>
                <input value={config.debugger.windows.cdbPath} onChange={(e) => setConfig({ ...config, debugger: { ...config.debugger, windows: { ...config.debugger.windows, cdbPath: e.target.value } } })} placeholder="C:\Program Files (x86)\Windows Kits\10\Debuggers\x64\cdb.exe" />
              </div>
              <div className="field">
                <label>Symbol Server Path</label>
                <input value={config.debugger.windows.symbolPath} onChange={(e) => setConfig({ ...config, debugger: { ...config.debugger, windows: { ...config.debugger.windows, symbolPath: e.target.value } } })} placeholder="srv*C:\Symbols*https://msdl.microsoft.com/download/symbols" />
              </div>
            </>
          ) : (
            <>
              <div className="field">
                <label>lldb Path</label>
                <input value={config.debugger.macos.lldbPath} onChange={(e) => setConfig({ ...config, debugger: { ...config.debugger, macos: { ...config.debugger.macos, lldbPath: e.target.value } } })} placeholder="/usr/bin/lldb" />
              </div>
              <div className="field">
                <label>dSYM Path</label>
                <input value={config.debugger.macos.dsymPath} onChange={(e) => setConfig({ ...config, debugger: { ...config.debugger, macos: { ...config.debugger.macos, dsymPath: e.target.value } } })} placeholder="/path/to/dsyms" />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
