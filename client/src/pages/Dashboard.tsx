import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { RefreshCw, Play, AlertTriangle, CheckCircle, Clock, Cpu, Pencil, Check, X, Search, Loader, Info, Trash2 } from 'lucide-react';
import { useSocket } from '../hooks/useSocket';
import { apiGet, apiPost, apiPatch, apiDelete } from '../hooks/useApi';
import StatusBadge from '../components/StatusBadge';
import type { CrashReport, CrashStatus, ApiSoftware } from '../types';
import './Dashboard.css';

interface RemoteRef { name: string; short: string; type: 'branch' | 'tag'; }

function defaultDateRange() {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - 7);
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

const SESSION_KEY = 'dashboard-state';

function loadSession(): { crashes: CrashReport[]; selectedSoftwareId: number; dateRange: { start: string; end: string }; statusMsg: string } | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function TagCell({ crash, onUpdate }: { crash: CrashReport; onUpdate: (id: number, tag: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(crash.releaseTag);
  const [searching, setSearching] = useState(false);
  const [matches, setMatches] = useState<RemoteRef[]>([]);
  const [searchError, setSearchError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setValue(crash.releaseTag); }, [crash.releaseTag]);
  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  const confirm = (e: React.MouseEvent) => {
    e.stopPropagation();
    onUpdate(crash.id, value);
    setEditing(false);
    setMatches([]);
  };
  const cancel = (e: React.MouseEvent) => {
    e.stopPropagation();
    setValue(crash.releaseTag);
    setEditing(false);
    setMatches([]);
    setSearchError('');
  };

  const searchRemote = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setSearching(true);
    setSearchError('');
    setMatches([]);
    try {
      const refs = await apiGet<RemoteRef[]>(
        `/git/refs/match?version=${encodeURIComponent(crash.swVersion)}`
      );
      // show tags first, then branches
      const sorted = [...refs.filter((r) => r.type === 'tag'), ...refs.filter((r) => r.type === 'branch')];
      setMatches(sorted);
      if (sorted.length === 0) setSearchError(`No refs found for "${crash.swVersion}"`);
    } catch (err: unknown) {
      setSearchError(err instanceof Error ? err.message : String(err));
    } finally {
      setSearching(false);
    }
  };

  const pickRef = (e: React.MouseEvent, ref: RemoteRef) => {
    e.stopPropagation();
    setValue(ref.short);
    onUpdate(crash.id, ref.short);
    setEditing(false);
    setMatches([]);
  };

  if (editing) {
    return (
      <div className="branch-edit" onClick={(e) => e.stopPropagation()}>
        <div className="branch-edit-row">
          <input
            ref={inputRef}
            className="branch-input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { onUpdate(crash.id, value); setEditing(false); setMatches([]); }
              if (e.key === 'Escape') { setValue(crash.releaseTag); setEditing(false); setMatches([]); }
            }}
          />
          <button className="branch-btn" onClick={searchRemote} title="Search remote tags/branches" disabled={searching}>
            {searching ? <Loader size={12} className="spinning" /> : <Search size={12} />}
          </button>
          <button className="branch-btn branch-btn-ok" onClick={confirm} title="Confirm"><Check size={12} /></button>
          <button className="branch-btn branch-btn-cancel" onClick={cancel} title="Cancel"><X size={12} /></button>
        </div>

        {matches.length > 0 && (
          <div className="branch-matches">
            {matches.map((ref) => (
              <button key={ref.name} className="branch-match-item" onClick={(e) => pickRef(e, ref)}>
                <span className={`ref-type ref-type-${ref.type}`}>{ref.type}</span>
                <span className="ref-name">{ref.short}</span>
              </button>
            ))}
          </div>
        )}
        {searchError && <div className="branch-search-error">{searchError}</div>}
      </div>
    );
  }

  return (
    <div className="branch-display" onClick={(e) => e.stopPropagation()}>
      <code className="branch-tag">{crash.releaseTag || '—'}</code>
      <button
        className="branch-edit-btn"
        onClick={(e) => { e.stopPropagation(); setEditing(true); }}
        title="Edit / search tag"
      >
        <Pencil size={12} />
      </button>
    </div>
  );
}

export default function Dashboard() {
  const sessionRef = useRef(loadSession());
  const restored = sessionRef.current;

  const [crashes, setCrashes] = useState<CrashReport[]>(restored?.crashes ?? []);
  const [softwares, setSoftwares] = useState<ApiSoftware[]>([]);
  const [historyIds, setHistoryIds] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);
  const [statusMsg, setStatusMsg] = useState(restored?.statusMsg ?? '');
  const [selectedSoftwareId, setSelectedSoftwareId] = useState<number>(restored?.selectedSoftwareId ?? 0);
  const [dateRange, setDateRange] = useState(restored?.dateRange ?? defaultDateRange());
  const [jiraUrl, setJiraUrl] = useState('');
  const navigate = useNavigate();
  const socketRef = useSocket();
  const tagFoldersRef = useRef<Record<string, string>>({});
  // skip auto-fetch on first render if state was restored from session
  const skipFetchRef = useRef(!!restored?.crashes?.length);

  // Build tag from folder + version: "pos" + "2.2.1.36" → "pos/2.2.1/36"
  const buildTag = (folder: string, swVersion: string): string => {
    const parts = swVersion.split('.');
    const mainVersion = parts.slice(0, 3).join('.');
    const build = parts[3];
    return build ? `${folder}/${mainVersion}/${build}` : `${folder}/${mainVersion}`;
  };

  const autoPopulateTags = (list: CrashReport[]) => {
    const folders = tagFoldersRef.current;
    setCrashes(list.map((c) => {
      const folder = folders[String(c.softwareId)];
      if (!folder || !c.swVersion) return { ...c, releaseTag: '' };
      return { ...c, releaseTag: buildTag(folder, c.swVersion) };
    }));
  };

  useEffect(() => {
    apiGet<{ git: { softwareTagFolders: Record<string, string> }; jira: { url: string } }>('/config')
      .then((cfg) => {
        const folders = cfg.git.softwareTagFolders ?? {};
        tagFoldersRef.current = folders;
        setJiraUrl(cfg.jira?.url ?? '');
        // Re-populate tags if crashes were already loaded before config arrived (race condition fix)
        setCrashes((prev) => {
          if (prev.length === 0) return prev;
          return prev.map((c) => {
            const folder = folders[String(c.softwareId)];
            if (!folder || !c.swVersion) return c;
            return { ...c, releaseTag: buildTag(folder, c.swVersion) };
          });
        });
      })
      .catch(() => {});
    apiGet<ApiSoftware[]>('/crash/softwares').then(setSoftwares).catch(() => {});
    apiGet<number[]>('/pipeline/history').then((ids) => setHistoryIds(new Set(ids))).catch(() => {});
    const socket = socketRef.current;
    if (!socket) return;
    socket.on('crashes:updated', (data: CrashReport[]) => autoPopulateTags(data));
    socket.on('status', (data: { message: string }) => setStatusMsg(data.message));
    const addToHistory = (data: { crashId: string }) => setHistoryIds((prev) => new Set([...prev, Number(data.crashId)]));
    socket.on('pipeline:complete', addToHistory);
    socket.on('pipeline:error', addToHistory);
    socket.on('pipeline:awaiting_ai', addToHistory);
    return () => { socket.off('crashes:updated'); socket.off('status'); socket.off('pipeline:complete'); socket.off('pipeline:error'); socket.off('pipeline:awaiting_ai'); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps


  useEffect(() => {
    if (skipFetchRef.current) { skipFetchRef.current = false; return; }
    if (selectedSoftwareId === 0) { setCrashes([]); return; }
    fetchCrashes();
  }, [selectedSoftwareId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist state to sessionStorage so Back navigation restores it
  useEffect(() => {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ crashes, selectedSoftwareId, dateRange, statusMsg }));
  }, [crashes, selectedSoftwareId, dateRange, statusMsg]);

  const fetchCrashes = async () => {
    setLoading(true);
    setStatusMsg('Fetching crash reports...');
    try {
      const body: Record<string, unknown> = { startDate: dateRange.start, endDate: dateRange.end };
      if (selectedSoftwareId !== 0) body.softwareId = selectedSoftwareId;
      const result = await apiPost<{ count: number; crashes: CrashReport[] }>('/crash/fetch', body);
      setStatusMsg(`Fetched ${result.count} reports`);
      if (result.crashes) autoPopulateTags(result.crashes);
    } catch (e: unknown) {
      setStatusMsg(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  };

  const runPipeline = async (crash: CrashReport) => {
    try {
      await apiPost(`/pipeline/run/${crash.id}`, crash);
      navigate(`/crash/${crash.id}`);
    } catch (e: unknown) {
      setStatusMsg(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const clearHistory = async (e: React.MouseEvent, crashId: number) => {
    e.stopPropagation();
    try {
      await apiDelete(`/pipeline/history/${crashId}`);
      setHistoryIds((prev) => { const next = new Set(prev); next.delete(crashId); return next; });
    } catch (err: unknown) {
      setStatusMsg(`Error clearing history: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const updateTag = async (id: number, tag: string) => {
    try {
      const updated = await apiPatch<CrashReport>(`/crash/${id}`, { releaseTag: tag });
      setCrashes((prev) => prev.map((c) => (c.id === id ? { ...c, releaseTag: updated.releaseTag } : c)));
    } catch (e: unknown) {
      setStatusMsg(`Error updating tag: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const stats = {
    total: crashes.length,
    new: crashes.filter((c) => c.status === 'new').length,
    completed: crashes.filter((c) => c.status === 'completed').length,
    error: crashes.filter((c) => c.status === 'error').length,
  };

  return (
    <div className="dashboard">
      <div className="page-header">
        <div>
          <h1>Dashboard</h1>
          <p className="page-subtitle">Crash report analysis & auto-fix pipeline</p>
        </div>
      </div>

      <div className="filter-bar">
        <div className="filter-group">
          <label>Software</label>
          <select value={selectedSoftwareId} onChange={(e) => setSelectedSoftwareId(Number(e.target.value))}>
            <option value={0}>-- Select --</option>
            {softwares.map((sw) => (
              <option key={sw.id} value={sw.id}>{sw.name}</option>
            ))}
          </select>
        </div>
        <div className="filter-group">
          <label>From</label>
          <input type="date" value={dateRange.start} onChange={(e) => setDateRange((r) => ({ ...r, start: e.target.value }))} />
        </div>
        <div className="filter-group">
          <label>To</label>
          <input type="date" value={dateRange.end} onChange={(e) => setDateRange((r) => ({ ...r, end: e.target.value }))} />
        </div>
        <button className="btn btn-primary" onClick={fetchCrashes} disabled={loading}>
          <RefreshCw size={16} className={loading ? 'spinning' : ''} />
          {loading ? 'Fetching...' : 'Fetch Reports'}
        </button>
      </div>

      {statusMsg && <div className="status-bar"><span>{statusMsg}</span></div>}

      <div className="stats-grid">
        <div className="stat-card"><Cpu size={24} className="stat-icon" /><div><div className="stat-value">{stats.total}</div><div className="stat-label">Total</div></div></div>
        <div className="stat-card"><Clock size={24} className="stat-icon stat-new" /><div><div className="stat-value">{stats.new}</div><div className="stat-label">New</div></div></div>
        <div className="stat-card"><CheckCircle size={24} className="stat-icon stat-completed" /><div><div className="stat-value">{stats.completed}</div><div className="stat-label">Fixed</div></div></div>
        <div className="stat-card"><AlertTriangle size={24} className="stat-icon stat-error" /><div><div className="stat-value">{stats.error}</div><div className="stat-label">Errors</div></div></div>
      </div>

      <div className="crash-list">
        <div className="section-header"><h2>Crash Reports</h2></div>
        {crashes.length === 0 ? (
          <div className="empty-state">
            <Cpu size={48} />
            {selectedSoftwareId === 0 ? (
              <>
                <h3>Select a software</h3>
                <p>Choose a software from the dropdown to load crash reports</p>
              </>
            ) : (
              <>
                <h3>No crash reports</h3>
                <p>No crashes found for the selected filters</p>
              </>
            )}
          </div>
        ) : (
          <div className="table-container">
            <table className="crash-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Subject</th>
                  <th>Version</th>
                  <th>Tag</th>
                  <th>OS</th>
                  <th>Issue</th>
                  <th>Date</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {crashes.map((crash) => (
                  <tr key={crash.id} onClick={() => navigate(`/crash/${crash.id}`)} className="crash-row">
                    <td className="crash-id">{crash.id}</td>
                    <td className="crash-subject">{crash.subject}</td>
                    <td><code className="branch-tag">{crash.swVersion}</code></td>
                    <td><TagCell crash={crash} onUpdate={updateTag} /></td>
                    <td className="crash-os">
                      {crash.osType === 'windows' ? '🪟 Windows' : crash.osType === 'macos' ? '🍎 macOS' : '—'}
                    </td>
                    <td className="crash-issue">
                      {crash.issueKey
                        ? <a href={`${jiraUrl.replace(/\/$/, '')}/browse/${crash.issueKey}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{crash.issueKey}</a>
                        : '—'}
                    </td>
                    <td className="crash-date">{new Date(crash.receivedAt).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                    <td><StatusBadge status={crash.status} /></td>
                    <td>
                      {historyIds.has(crash.id) ? (
                        <div className="action-group">
                          <button className="btn btn-sm btn-info" onClick={(e) => { e.stopPropagation(); navigate(`/crash/${crash.id}`); }}>
                            <Info size={14} /> View Result
                          </button>
                          <button className="btn btn-sm btn-ghost" onClick={(e) => clearHistory(e, crash.id)} title="Clear history">
                            <Trash2 size={14} />
                          </button>
                        </div>
                      ) : (
                        <>
                          {crash.status === 'new' && (
                            <button className="btn btn-sm btn-accent" onClick={(e) => { e.stopPropagation(); runPipeline(crash); }}>
                              <Play size={14} /> Run
                            </button>
                          )}
                          {(['analyzing', 'fixing', 'creating_pr'] as CrashStatus[]).includes(crash.status) && (
                            <button className="btn btn-sm btn-running" onClick={(e) => { e.stopPropagation(); navigate(`/crash/${crash.id}`); }}>
                              <Loader size={14} className="spinning" /> Pipeline...
                            </button>
                          )}
                          {crash.analysis?.prUrl && (
                            <a href={crash.analysis.prUrl} target="_blank" rel="noreferrer" className="btn btn-sm btn-success" onClick={(e) => e.stopPropagation()}>View PR</a>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
