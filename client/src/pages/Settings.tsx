import { useState, useEffect } from 'react';
import { Save, CheckCircle, AlertCircle, Trash2, Plus, ChevronDown, ChevronRight } from 'lucide-react';
import { apiGet, apiPost, apiDelete } from '../hooks/useApi';
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
  const [jiraTestResult, setJiraTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [jiraTestLoading, setJiraTestLoading] = useState(false);
  const [kernelMapOpenSw, setKernelMapOpenSw] = useState<Record<string, boolean>>({});
  const [newKernelSwVer, setNewKernelSwVer] = useState<Record<string, string>>({});
  const [newKernelVer, setNewKernelVer] = useState<Record<string, string>>({});

  const SECTION_KEYS = [
    'releaseBuild', 'crashReportServer', 'claude', 'git',
    'jiraSprintIds', 'tagFolders', 'kernelMap', 'tagBranch',
    'jira', 'debugger', 'autoUpdate',
  ] as const;
  type SectionKey = typeof SECTION_KEYS[number];

  const [sectionOpen, setSectionOpen] = useState<Record<SectionKey, boolean>>(() => {
    try {
      const saved = localStorage.getItem('settings-section-open');
      if (saved) {
        const parsed = JSON.parse(saved) as Partial<Record<SectionKey, boolean>>;
        return Object.fromEntries(SECTION_KEYS.map((k) => [k, parsed[k] ?? true])) as Record<SectionKey, boolean>;
      }
    } catch {
      // ignore
    }
    return Object.fromEntries(SECTION_KEYS.map((k) => [k, true])) as Record<SectionKey, boolean>;
  });

  useEffect(() => {
    try { localStorage.setItem('settings-section-open', JSON.stringify(sectionOpen)); } catch { /* ignore */ }
  }, [sectionOpen]);

  const toggleSection = (key: SectionKey) => {
    setSectionOpen((prev) => ({ ...prev, [key]: !prev[key] }));
  };

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
    await apiDelete(`/git/tag-branch-map/${encodeURIComponent(tag)}`).catch(() => {});
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
        <div className={`settings-section ${sectionOpen.releaseBuild ? '' : 'is-collapsed'}`}>
          <h3 className="settings-section-header" onClick={() => toggleSection('releaseBuild')}>
            {sectionOpen.releaseBuild ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            <span>Release Build</span>
          </h3>
          {sectionOpen.releaseBuild && (<>
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
          </>)}
        </div>

        {/* Crash Report Server */}
        <div className={`settings-section ${sectionOpen.crashReportServer ? '' : 'is-collapsed'}`}>
          <h3 className="settings-section-header" onClick={() => toggleSection('crashReportServer')}>
            {sectionOpen.crashReportServer ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            <span>Crash Report Server</span>
          </h3>
          {sectionOpen.crashReportServer && (<>
          <div className="field">
            <label>Server URL</label>
            <input
              value={config.crashReportServer.url}
              onChange={(e) => setConfig({ ...config, crashReportServer: { ...config.crashReportServer, url: e.target.value } })}
              placeholder="http://rnd3.meditlink.com:5001"
            />
            <p className="field-help">Software and date filters are available on the Dashboard.</p>
          </div>
          </>)}
        </div>

        {/* Claude */}
        <div className={`settings-section ${sectionOpen.claude ? '' : 'is-collapsed'}`}>
          <h3 className="settings-section-header" onClick={() => toggleSection('claude')}>
            {sectionOpen.claude ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            <span>Claude API</span>
          </h3>
          {sectionOpen.claude && (<>
          <div className="field">
            <label>Model</label>
            <input value={config.claude.model} onChange={(e) => update('claude', 'model', e.target.value)} placeholder="claude-sonnet-4-6" />
            <p className="field-help">e.g. claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5-20251001</p>
          </div>
          </>)}
        </div>

        {/* Git */}
        <div className={`settings-section ${sectionOpen.git ? '' : 'is-collapsed'}`}>
          <h3 className="settings-section-header" onClick={() => toggleSection('git')}>
            {sectionOpen.git ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            <span>Git Repository</span>
          </h3>
          {sectionOpen.git && (<>
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
            <input value={config.git.defaultBranch} onChange={(e) => update('git', 'defaultBranch', e.target.value)} placeholder="develop" />
          </div>
          </>)}
        </div>

        {/* Jira Sprint IDs */}
        <div className={`settings-section ${sectionOpen.jiraSprintIds ? '' : 'is-collapsed'}`}>
          <h3 className="settings-section-header" onClick={() => toggleSection('jiraSprintIds')}>
            {sectionOpen.jiraSprintIds ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            <span>Jira Sprint IDs</span>
          </h3>
          {sectionOpen.jiraSprintIds && (<>
          <p className="field-help" style={{ marginBottom: 14 }}>
            소프트웨어별 Jira 스프린트 ID를 입력하면 분류 실행 시 해당 스프린트의 이슈만 조회합니다.<br />
            비워두면 프로젝트 전체 미완료 이슈를 조회합니다.
          </p>
          {softwares.length === 0 && (
            <p className="field-help">No softwares loaded (check Crash Report Server URL).</p>
          )}
          {softwares.map((sw) => (
            <div className="field tag-folder-row" key={sw.id}>
              <label>{sw.name} <span className="field-hint">ID: {sw.id}</span></label>
              <input
                type="text"
                style={{ maxWidth: 140 }}
                value={config.jiraSprintIds?.[String(sw.id)] ?? ''}
                onChange={(e) => {
                  const updated = { ...(config.jiraSprintIds ?? {}) };
                  const val = e.target.value.trim();
                  if (val) updated[String(sw.id)] = Number(val);
                  else delete updated[String(sw.id)];
                  setConfig({ ...config, jiraSprintIds: updated });
                }}
                placeholder="Sprint ID"
              />
            </div>
          ))}
          </>)}
        </div>

        {/* Software Tag Folders */}
        <div className={`settings-section ${sectionOpen.tagFolders ? '' : 'is-collapsed'}`}>
          <h3 className="settings-section-header" onClick={() => toggleSection('tagFolders')}>
            {sectionOpen.tagFolders ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            <span>Software Tag Folders</span>
          </h3>
          {sectionOpen.tagFolders && (<>
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
          </>)}
        </div>

        {/* Kernel Version Mapping */}
        <div className={`settings-section ${sectionOpen.kernelMap ? '' : 'is-collapsed'}`}>
          <h3 className="settings-section-header" onClick={() => toggleSection('kernelMap')}>
            {sectionOpen.kernelMap ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            <span>Kernel Version Mapping <span className="field-hint">(SW 별로 SW 버전 → Kernel 버전)</span></span>
          </h3>
          {sectionOpen.kernelMap && (<>
          <p className="field-help" style={{ marginTop: 0, marginBottom: 14 }}>
            Kernel symbol 파일이 없는 SW 버전에 사용할 Kernel 버전을 SW 별로 매핑합니다.
          </p>
          {softwares.length === 0 && (
            <p className="field-help">No softwares loaded (check Crash Report Server URL).</p>
          )}
          {softwares.map((sw) => {
            const swKey = String(sw.id);
            const swMap = config.kernelVersionMap?.[swKey] ?? {};
            const open = kernelMapOpenSw[swKey] ?? false;
            const newSv = newKernelSwVer[swKey] ?? '';
            const newKv = newKernelVer[swKey] ?? '';
            const entryCount = Object.keys(swMap).length;
            return (
              <div key={sw.id} className="kernel-sw-group">
                <div
                  className="kernel-sw-header"
                  onClick={() => setKernelMapOpenSw({ ...kernelMapOpenSw, [swKey]: !open })}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    <strong>{sw.name}</strong>
                    <span className="field-hint">ID: {sw.id}</span>
                  </span>
                  <span className="field-hint">{entryCount} mapping{entryCount === 1 ? '' : 's'}</span>
                </div>
                {open && (
                  <div className="kernel-sw-body">
                    {entryCount > 0 && (
                      <table className="mapping-table">
                        <thead>
                          <tr><th>SW Version</th><th>Kernel Version</th><th></th></tr>
                        </thead>
                        <tbody>
                          {Object.entries(swMap).map(([swVer, kernelVer]) => (
                            <tr key={swVer}>
                              <td><code>{swVer}</code></td>
                              <td><code>{kernelVer}</code></td>
                              <td>
                                <button
                                  className="btn-icon-danger"
                                  onClick={() => {
                                    const swUpdated = { ...swMap };
                                    delete swUpdated[swVer];
                                    const allUpdated = { ...(config.kernelVersionMap ?? {}) };
                                    if (Object.keys(swUpdated).length > 0) allUpdated[swKey] = swUpdated;
                                    else delete allUpdated[swKey];
                                    setConfig({ ...config, kernelVersionMap: allUpdated });
                                  }}
                                  title="Delete"
                                >
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
                        value={newSv}
                        onChange={(e) => setNewKernelSwVer({ ...newKernelSwVer, [swKey]: e.target.value })}
                        placeholder="SW version (e.g. 2.2.1.36)"
                      />
                      <input
                        className="mapping-input"
                        value={newKv}
                        onChange={(e) => setNewKernelVer({ ...newKernelVer, [swKey]: e.target.value })}
                        placeholder="Kernel version (e.g. 1.5.0)"
                      />
                      <button
                        className="btn btn-sm btn-accent"
                        onClick={() => {
                          const sv = newSv.trim();
                          const kv = newKv.trim();
                          if (!sv || !kv) return;
                          const allUpdated = { ...(config.kernelVersionMap ?? {}) };
                          allUpdated[swKey] = { ...(allUpdated[swKey] ?? {}), [sv]: kv };
                          setConfig({ ...config, kernelVersionMap: allUpdated });
                          setNewKernelSwVer({ ...newKernelSwVer, [swKey]: '' });
                          setNewKernelVer({ ...newKernelVer, [swKey]: '' });
                        }}
                        disabled={!newSv.trim() || !newKv.trim()}
                      >
                        <Plus size={14} /> Add
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          </>)}
        </div>

        {/* Tag → Branch Mapping */}
        <div className={`settings-section ${sectionOpen.tagBranch ? '' : 'is-collapsed'}`}>
          <h3 className="settings-section-header" onClick={() => toggleSection('tagBranch')}>
            {sectionOpen.tagBranch ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            <span>Tag → Branch Mapping <span className="field-hint">(used for PR base branch only, does not affect checkout)</span></span>
          </h3>
          {sectionOpen.tagBranch && (<>
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
          </>)}
        </div>

        {/* Jira */}
        <div className={`settings-section ${sectionOpen.jira ? '' : 'is-collapsed'}`}>
          <h3 className="settings-section-header" onClick={() => toggleSection('jira')}>
            {sectionOpen.jira ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            <span>Jira Integration <span className="field-hint">(분류 기능에 사용 / read-only)</span></span>
          </h3>
          {sectionOpen.jira && (<>
          <div className="field">
            <label>Jira URL</label>
            <input
              value={config.jira?.url ?? ''}
              onChange={(e) => setConfig({ ...config, jira: { ...(config.jira ?? { email: '', apiToken: '' }), url: e.target.value } })}
              placeholder="https://yourcompany.atlassian.net"
            />
          </div>
          <div className="field">
            <label>Email</label>
            <input
              value={config.jira?.email ?? ''}
              onChange={(e) => setConfig({ ...config, jira: { ...(config.jira ?? { url: '', apiToken: '' }), email: e.target.value } })}
              placeholder="your@email.com"
            />
          </div>
          <div className="field">
            <label>API Token <span className="field-hint">(id.atlassian.com → Security → API tokens)</span></label>
            <input
              type="password"
              value={config.jira?.apiToken ?? ''}
              onChange={(e) => setConfig({ ...config, jira: { ...(config.jira ?? { url: '', email: '' }), apiToken: e.target.value } })}
              placeholder="API Token"
            />
          </div>
          <p className="field-help">Project Key는 crash의 issueKey에서 자동으로 감지됩니다. (예: APOS-2486 → APOS)</p>
          <div className="field">
            <label>연결 테스트</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button
                className="btn-secondary"
                disabled={jiraTestLoading}
                onClick={async () => {
                  setJiraTestResult(null);
                  setJiraTestLoading(true);
                  try {
                    const res = await apiPost<{ ok: boolean; displayName?: string; error?: string }>('/config/jira-test', {
                      url: config?.jira?.url ?? '',
                      email: config?.jira?.email ?? '',
                      apiToken: config?.jira?.apiToken ?? '',
                    });
                    if (res.ok) {
                      setJiraTestResult({ ok: true, text: `연결 성공 — ${res.displayName ?? 'OK'}` });
                    } else {
                      setJiraTestResult({ ok: false, text: res.error ?? '연결 실패' });
                    }
                  } catch (e: unknown) {
                    setJiraTestResult({ ok: false, text: e instanceof Error ? e.message : '연결 실패' });
                  } finally {
                    setJiraTestLoading(false);
                  }
                }}
              >
                {jiraTestLoading ? '테스트 중...' : 'Jira 연결 테스트'}
              </button>
              {jiraTestResult && (
                <span style={{ color: jiraTestResult.ok ? 'var(--success)' : 'var(--error)', fontSize: 13 }}>
                  {jiraTestResult.ok ? '✓' : '✗'} {jiraTestResult.text}
                </span>
              )}
            </div>
          </div>
          </>)}
        </div>

        {/* Debugger */}
        <div className={`settings-section ${sectionOpen.debugger ? '' : 'is-collapsed'}`}>
          <h3 className="settings-section-header" onClick={() => toggleSection('debugger')}>
            {sectionOpen.debugger ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            <span>Debugging Tools <span className="platform-badge">{platform === 'macos' ? 'macOS' : 'Windows'}</span></span>
          </h3>
          {sectionOpen.debugger && (<>
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
          </>)}
        </div>

        {/* Auto Update */}
        <div className={`settings-section ${sectionOpen.autoUpdate ? '' : 'is-collapsed'}`}>
          <h3 className="settings-section-header" onClick={() => toggleSection('autoUpdate')}>
            {sectionOpen.autoUpdate ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            <span>자동 업데이트</span>
          </h3>
          {sectionOpen.autoUpdate && (<>
          <div className="field field-toggle">
            <label>
              <input
                type="checkbox"
                checked={config.autoUpdate?.enabled !== false}
                onChange={(e) => setConfig({
                  ...config,
                  autoUpdate: { ...(config.autoUpdate ?? { githubRepo: '' }), enabled: e.target.checked },
                })}
              />
              업데이트 확인 활성화
            </label>
            <p className="field-help">비활성화하면 앱 시작 시 업데이트를 확인하지 않습니다.</p>
          </div>
          <div className="field">
            <label>GitHub Repository <span className="field-hint">(CrashPilot 배포 repo)</span></label>
            <input
              value={config.autoUpdate?.githubRepo ?? ''}
              onChange={(e) => setConfig({
                ...config,
                autoUpdate: { ...(config.autoUpdate ?? {}), githubRepo: e.target.value },
              })}
              placeholder="owner/repo 또는 https://github.com/owner/repo"
            />
            <p className="field-help">
              설정하면 앱 시작 시 자동으로 업데이트를 확인합니다. 형식: <code>owner/repo</code> 또는 GitHub URL
            </p>
          </div>
          <div className="field">
            <label>GitHub Token <span className="field-hint">(비공개 repo인 경우)</span></label>
            <input
              type="password"
              value={config.autoUpdate?.githubToken ?? ''}
              onChange={(e) => setConfig({
                ...config,
                autoUpdate: { ...(config.autoUpdate ?? { githubRepo: '' }), githubToken: e.target.value },
              })}
              placeholder="ghp_..."
            />
            <p className="field-help">공개 repo라면 비워두세요.</p>
          </div>
          </>)}
        </div>
      </div>
    </div>
  );
}
