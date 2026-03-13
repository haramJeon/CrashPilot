import { useState, useEffect } from 'react';
import { Save, CheckCircle, AlertCircle } from 'lucide-react';
import { apiGet, apiPost } from '../hooks/useApi';
import type { AppConfig, Platform } from '../types';
import './Settings.css';

export default function Settings() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [platform, setPlatform] = useState<Platform>('windows');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [validation, setValidation] = useState<{ valid: boolean; issues: string[] } | null>(null);

  useEffect(() => {
    loadConfig();
  }, []);

  const loadConfig = async () => {
    try {
      const data = await apiGet<AppConfig>('/config');
      setConfig(data);
      const plat = await apiGet<{ platform: Platform }>('/config/platform');
      setPlatform(plat.platform);
      const val = await apiGet<{ valid: boolean; issues: string[] }>('/config/validate');
      setValidation(val);
    } catch (e: any) {
      setMessage({ type: 'error', text: e.message });
    }
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
    } catch (e: any) {
      setMessage({ type: 'error', text: e.message });
    } finally {
      setSaving(false);
    }
  };

  const update = (section: keyof AppConfig, key: string, value: string) => {
    if (!config) return;
    setConfig({
      ...config,
      [section]: { ...config[section], [key]: value },
    });
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
          <ul>
            {validation.issues.map((issue, idx) => (
              <li key={idx}>{issue}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="settings-grid">
        {/* Outlook */}
        <div className="settings-section">
          <h3>Microsoft Outlook (Graph API)</h3>
          <div className="field">
            <label>Client ID</label>
            <input value={config.outlook.clientId} onChange={(e) => update('outlook', 'clientId', e.target.value)} placeholder="Azure AD App Client ID" />
          </div>
          <div className="field">
            <label>Client Secret</label>
            <input type="password" value={config.outlook.clientSecret} onChange={(e) => update('outlook', 'clientSecret', e.target.value)} placeholder="Azure AD App Client Secret" />
          </div>
          <div className="field">
            <label>Tenant ID</label>
            <input value={config.outlook.tenantId} onChange={(e) => update('outlook', 'tenantId', e.target.value)} placeholder="Azure AD Tenant ID" />
          </div>
          <div className="field">
            <label>User ID (email)</label>
            <input value={config.outlook.userId} onChange={(e) => update('outlook', 'userId', e.target.value)} placeholder="user@company.com" />
          </div>
          <div className="field">
            <label>Mail Filter</label>
            <input value={config.outlook.mailFilter} onChange={(e) => update('outlook', 'mailFilter', e.target.value)} placeholder="subject:'Crash Report'" />
          </div>
        </div>

        {/* Claude */}
        <div className="settings-section">
          <h3>Claude API</h3>
          <div className="field">
            <label>API Key</label>
            <input type="password" value={config.claude.apiKey} onChange={(e) => update('claude', 'apiKey', e.target.value)} placeholder="sk-ant-..." />
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

        {/* Debugger - platform aware */}
        <div className="settings-section">
          <h3>Debugging Tools <span className="platform-badge">{platform === 'macos' ? 'macOS' : 'Windows'}</span></h3>

          {platform === 'windows' ? (
            <>
              <div className="field">
                <label>CDB Path</label>
                <input
                  value={config.debugger.windows.cdbPath}
                  onChange={(e) => setConfig({
                    ...config,
                    debugger: { ...config.debugger, windows: { ...config.debugger.windows, cdbPath: e.target.value } }
                  })}
                  placeholder="C:\Program Files (x86)\Windows Kits\10\Debuggers\x64\cdb.exe"
                />
              </div>
              <div className="field">
                <label>Symbol Server Path</label>
                <input
                  value={config.debugger.windows.symbolPath}
                  onChange={(e) => setConfig({
                    ...config,
                    debugger: { ...config.debugger, windows: { ...config.debugger.windows, symbolPath: e.target.value } }
                  })}
                  placeholder="srv*C:\Symbols*https://msdl.microsoft.com/download/symbols"
                />
              </div>
            </>
          ) : (
            <>
              <div className="field">
                <label>lldb Path</label>
                <input
                  value={config.debugger.macos.lldbPath}
                  onChange={(e) => setConfig({
                    ...config,
                    debugger: { ...config.debugger, macos: { ...config.debugger.macos, lldbPath: e.target.value } }
                  })}
                  placeholder="/usr/bin/lldb"
                />
              </div>
              <div className="field">
                <label>dSYM Path (symbol files directory)</label>
                <input
                  value={config.debugger.macos.dsymPath}
                  onChange={(e) => setConfig({
                    ...config,
                    debugger: { ...config.debugger, macos: { ...config.debugger.macos, dsymPath: e.target.value } }
                  })}
                  placeholder="/path/to/dsyms"
                />
              </div>
            </>
          )}
        </div>

        {/* Git */}
        <div className="settings-section">
          <h3>Git Repository</h3>
          <div className="field">
            <label>Local Repository Path</label>
            <input value={config.git.repoPath} onChange={(e) => update('git', 'repoPath', e.target.value)} placeholder={platform === 'macos' ? '/Users/you/projects/my-repo' : 'C:\\Projects\\my-repo'} />
          </div>
        </div>
      </div>
    </div>
  );
}
