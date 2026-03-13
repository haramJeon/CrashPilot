import { useState, useEffect, useCallback } from 'react';
import { Save, CheckCircle, AlertCircle, Link, Unlink, Loader } from 'lucide-react';
import { apiGet, apiPost } from '../hooks/useApi';
import type { AppConfig, Platform } from '../types';
import './Settings.css';

interface AuthStatus {
  connected: boolean;
  account?: string;
}

export default function Settings() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [platform, setPlatform] = useState<Platform>('windows');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [validation, setValidation] = useState<{ valid: boolean; issues: string[] } | null>(null);
  const [authStatus, setAuthStatus] = useState<AuthStatus>({ connected: false });
  const [connecting, setConnecting] = useState(false);

  const refreshAuthStatus = useCallback(async () => {
    const status = await apiGet<AuthStatus>('/auth/status');
    setAuthStatus(status);
  }, []);

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
        await refreshAuthStatus();
      } catch (e: any) {
        setMessage({ type: 'error', text: e.message });
      }
    };
    init();
  }, []);

  // Listen for OAuth popup result
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type === 'auth_success') {
        setConnecting(false);
        refreshAuthStatus();
        setMessage({ type: 'success', text: 'Outlook connected successfully!' });
      } else if (e.data?.type === 'auth_error') {
        setConnecting(false);
        setMessage({ type: 'error', text: `Outlook auth failed: ${e.data.error}` });
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  const connectOutlook = async () => {
    if (!config?.outlook.clientId || !config?.outlook.tenantId) {
      setMessage({ type: 'error', text: 'Save Client ID and Tenant ID first.' });
      return;
    }
    setConnecting(true);
    setMessage(null);
    try {
      const { url } = await apiGet<{ url: string }>('/auth/login');
      window.open(url, 'outlook-auth', 'width=520,height=620,left=200,top=100');
    } catch (e: any) {
      setConnecting(false);
      setMessage({ type: 'error', text: e.message });
    }
  };

  const disconnectOutlook = async () => {
    await apiPost('/auth/logout');
    setAuthStatus({ connected: false });
    setMessage({ type: 'success', text: 'Outlook disconnected.' });
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
    setConfig({ ...config, [section]: { ...config[section], [key]: value } });
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
            {validation.issues.map((issue, idx) => <li key={idx}>{issue}</li>)}
          </ul>
        </div>
      )}

      <div className="settings-grid">
        {/* Outlook */}
        <div className="settings-section">
          <h3>Microsoft Outlook</h3>

          {/* Connection status */}
          <div className="auth-status-bar">
            {authStatus.connected ? (
              <>
                <span className="auth-connected">
                  <CheckCircle size={16} />
                  Connected: {authStatus.account}
                </span>
                <button className="btn btn-sm btn-danger" onClick={disconnectOutlook}>
                  <Unlink size={14} />
                  Disconnect
                </button>
              </>
            ) : (
              <>
                <span className="auth-disconnected">
                  <AlertCircle size={16} />
                  Not connected
                </span>
                <button className="btn btn-sm btn-accent" onClick={connectOutlook} disabled={connecting}>
                  {connecting ? <Loader size={14} className="spinning" /> : <Link size={14} />}
                  {connecting ? 'Connecting...' : 'Connect Outlook'}
                </button>
              </>
            )}
          </div>

          <div className="field">
            <label>Client ID <span className="field-hint">(Azure AD App → Overview)</span></label>
            <input value={config.outlook.clientId} onChange={(e) => update('outlook', 'clientId', e.target.value)} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
          </div>
          <div className="field">
            <label>Tenant ID <span className="field-hint">(Azure AD App → Overview)</span></label>
            <input value={config.outlook.tenantId} onChange={(e) => update('outlook', 'tenantId', e.target.value)} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
          </div>
          <div className="field">
            <label>Mail Filter</label>
            <input value={config.outlook.mailFilter} onChange={(e) => update('outlook', 'mailFilter', e.target.value)} placeholder="subject:'Crash Report'" />
          </div>
          <p className="field-help">
            Azure AD App type: <strong>Public client</strong> · Permission: <strong>Mail.Read (Delegated)</strong> · Redirect URI: <code>http://localhost:3001/api/auth/callback</code>
          </p>
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

        {/* Debugger */}
        <div className="settings-section">
          <h3>Debugging Tools <span className="platform-badge">{platform === 'macos' ? 'macOS' : 'Windows'}</span></h3>
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
