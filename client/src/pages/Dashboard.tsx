import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { RefreshCw, Play, AlertTriangle, CheckCircle, Clock, Cpu, Pencil, Check, X, Search, Loader } from 'lucide-react';
import { useSocket } from '../hooks/useSocket';
import { apiGet, apiPost, apiPatch } from '../hooks/useApi';
import StatusBadge from '../components/StatusBadge';
import type { CrashReport, ApiSoftware } from '../types';
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

function BranchCell({ crash, onUpdate }: { crash: CrashReport; onUpdate: (id: number, branch: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(crash.releaseBranch);
  const [searching, setSearching] = useState(false);
  const [matches, setMatches] = useState<RemoteRef[]>([]);
  const [searchError, setSearchError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setValue(crash.releaseBranch); }, [crash.releaseBranch]);
  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  const confirm = (e: React.MouseEvent) => {
    e.stopPropagation();
    onUpdate(crash.id, value);
    setEditing(false);
    setMatches([]);
  };
  const cancel = (e: React.MouseEvent) => {
    e.stopPropagation();
    setValue(crash.releaseBranch);
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
      const refs = await apiGet<RemoteRef[]>(`/git/refs/match?version=${encodeURIComponent(crash.swVersion)}`);
      setMatches(refs);
      if (refs.length === 0) setSearchError(`No refs found for "${crash.swVersion}"`);
    } catch (err: any) {
      setSearchError(err.message);
    } finally {
      setSearching(false);
    }
  };

  const pickRef = (e: React.MouseEvent, ref: RemoteRef) => {
    e.stopPropagation();
    // Use branch name directly, or derive branch from tag if needed
    const branch = ref.type === 'branch' ? ref.short : ref.short;
    setValue(branch);
    onUpdate(crash.id, branch);
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
              if (e.key === 'Escape') { setValue(crash.releaseBranch); setEditing(false); setMatches([]); }
            }}
          />
          <button className="branch-btn" onClick={searchRemote} title="Search remote refs" disabled={searching}>
            {searching ? <Loader size={12} className="spinning" /> : <Search size={12} />}
          </button>
          <button className="branch-btn branch-btn-ok" onClick={confirm} title="Confirm"><Check size={12} /></button>
          <button className="branch-btn branch-btn-cancel" onClick={cancel} title="Cancel"><X size={12} /></button>
        </div>

        {/* Remote ref results */}
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
      <code className="branch-tag">{crash.releaseBranch}</code>
      <button
        className="branch-edit-btn"
        onClick={(e) => { e.stopPropagation(); setEditing(true); }}
        title="Edit / search branch"
      >
        <Pencil size={12} />
      </button>
    </div>
  );
}

export default function Dashboard() {
  const [crashes, setCrashes] = useState<CrashReport[]>([]);
  const [softwares, setSoftwares] = useState<ApiSoftware[]>([]);
  const [loading, setLoading] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [selectedSoftwareId, setSelectedSoftwareId] = useState<number>(0);
  const [dateRange, setDateRange] = useState(defaultDateRange);
  const navigate = useNavigate();
  const socketRef = useSocket();

  useEffect(() => {
    apiGet<CrashReport[]>('/crash').then(setCrashes).catch(() => {});
    apiGet<ApiSoftware[]>('/crash/softwares').then(setSoftwares).catch(() => {});
    const socket = socketRef.current;
    if (!socket) return;
    socket.on('crashes:updated', (data: CrashReport[]) => setCrashes(data));
    socket.on('status', (data: { message: string }) => setStatusMsg(data.message));
    return () => { socket.off('crashes:updated'); socket.off('status'); };
  }, []);

  const fetchCrashes = async () => {
    setLoading(true);
    setStatusMsg('Fetching crash reports...');
    try {
      const body: Record<string, any> = { startDate: dateRange.start, endDate: dateRange.end };
      if (selectedSoftwareId !== 0) body.softwareId = selectedSoftwareId;
      const result = await apiPost<{ count: number }>('/crash/fetch', body);
      setStatusMsg(`Fetched ${result.count} reports`);
    } catch (e: any) {
      setStatusMsg(`Error: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  const runPipeline = async (crash: CrashReport) => {
    try {
      await apiPost(`/pipeline/run/${crash.id}`, crash);
      navigate(`/crash/${crash.id}`);
    } catch (e: any) {
      setStatusMsg(`Error: ${e.message}`);
    }
  };

  const updateBranch = async (id: number, branch: string) => {
    try {
      const updated = await apiPatch<CrashReport>(`/crash/${id}`, { releaseBranch: branch });
      setCrashes((prev) => prev.map((c) => (c.id === id ? { ...c, releaseBranch: updated.releaseBranch } : c)));
    } catch (e: any) {
      setStatusMsg(`Error updating branch: ${e.message}`);
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
            <option value={0}>All</option>
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
            <h3>No crash reports</h3>
            <p>Select filters and click "Fetch Reports"</p>
          </div>
        ) : (
          <div className="table-container">
            <table className="crash-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Subject</th>
                  <th>Version</th>
                  <th>Branch</th>
                  <th>Exception</th>
                  <th>Region</th>
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
                    <td><BranchCell crash={crash} onUpdate={updateBranch} /></td>
                    <td className="crash-exception">{crash.exceptionCode || crash.bugcheck || '—'}</td>
                    <td className="crash-region">{crash.region || '—'}</td>
                    <td className="crash-date">{new Date(crash.receivedAt).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                    <td><StatusBadge status={crash.status} /></td>
                    <td>
                      {crash.status === 'new' && (
                        <button className="btn btn-sm btn-accent" onClick={(e) => { e.stopPropagation(); runPipeline(crash); }}>
                          <Play size={14} /> Run
                        </button>
                      )}
                      {crash.analysis?.prUrl && (
                        <a href={crash.analysis.prUrl} target="_blank" rel="noreferrer" className="btn btn-sm btn-success" onClick={(e) => e.stopPropagation()}>View PR</a>
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
