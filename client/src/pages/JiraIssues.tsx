import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { RefreshCw, ChevronDown, ChevronRight, Play, Info, Loader, Ticket, AlertTriangle, Trash2 } from 'lucide-react';
import { apiGet, apiPost, apiDelete } from '../hooks/useApi';
import { useSocket } from '../hooks/useSocket';
import StatusBadge from '../components/StatusBadge';
import type { CrashReport, CrashStatus, ApiSoftware } from '../types';
import './JiraIssues.css';

interface JiraIssue {
  key: string;
  summary: string;
  status: string;
  issueType: string;
  description?: string;
}

interface SprintIssuesResponse {
  sprintId: number | null;
  issues: JiraIssue[];
}

export default function JiraIssues() {
  const navigate = useNavigate();
  const socketRef = useSocket();

  const [softwares, setSoftwares] = useState<ApiSoftware[]>([]);
  const [selectedSoftwareId, setSelectedSoftwareId] = useState<number>(0);
  const [sprintId, setSprintId] = useState<number | null>(null);
  const [issues, setIssues] = useState<JiraIssue[]>([]);
  const [loadingIssues, setLoadingIssues] = useState(false);
  const [issuesError, setIssuesError] = useState('');

  const [selectedIssueKey, setSelectedIssueKey] = useState<string | null>(null);
  const [crashes, setCrashes] = useState<CrashReport[]>([]);
  const [loadingCrashes, setLoadingCrashes] = useState(false);
  const [crashesError, setCrashesError] = useState('');
  const [jiraUrl, setJiraUrl] = useState('');

  const [historyIds, setHistoryIds] = useState<Set<number>>(new Set());
  const [statusMsg, setStatusMsg] = useState('');

  useEffect(() => {
    apiGet<ApiSoftware[]>('/crash/softwares').then(setSoftwares).catch(() => {});
    apiGet<{ jira?: { url: string } }>('/config').then((cfg) => setJiraUrl(cfg.jira?.url ?? '')).catch(() => {});
    apiGet<number[]>('/pipeline/history').then((ids) => setHistoryIds(new Set(ids))).catch(() => {});

    const socket = socketRef.current;
    if (!socket) return;
    socket.on('status', (data: { message: string }) => setStatusMsg(data.message));
    const addToHistory = (data: { crashId: string }) =>
      setHistoryIds((prev) => new Set([...prev, Number(data.crashId)]));
    socket.on('pipeline:complete', addToHistory);
    socket.on('pipeline:error', addToHistory);
    socket.on('pipeline:awaiting_ai', addToHistory);
    return () => {
      socket.off('status');
      socket.off('pipeline:complete');
      socket.off('pipeline:error');
      socket.off('pipeline:awaiting_ai');
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const loadSprintIssues = async () => {
    if (selectedSoftwareId === 0) return;
    setLoadingIssues(true);
    setIssuesError('');
    setIssues([]);
    setSelectedIssueKey(null);
    setCrashes([]);
    try {
      const data = await apiGet<SprintIssuesResponse>(`/jira/sprint-issues?softwareId=${selectedSoftwareId}`);
      setSprintId(data.sprintId);
      setIssues(data.issues);
      if (data.issues.length === 0) {
        setIssuesError('이 소프트웨어의 스프린트에 열린 이슈가 없습니다.');
      }
    } catch (e: unknown) {
      setIssuesError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingIssues(false);
    }
  };

  useEffect(() => {
    if (selectedSoftwareId !== 0) {
      loadSprintIssues();
    } else {
      setIssues([]);
      setSprintId(null);
      setSelectedIssueKey(null);
      setCrashes([]);
    }
  }, [selectedSoftwareId]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadCrashesForIssue = async (issueKey: string) => {
    if (selectedIssueKey === issueKey) {
      setSelectedIssueKey(null);
      setCrashes([]);
      return;
    }
    setSelectedIssueKey(issueKey);
    setLoadingCrashes(true);
    setCrashesError('');
    setCrashes([]);
    try {
      const result = await apiPost<{ count: number; crashes: CrashReport[] }>('/crash/fetch', {
        softwareId: selectedSoftwareId,
      });
      const filtered = (result.crashes ?? []).filter(
        (c) => c.issueKey === issueKey,
      );
      setCrashes(filtered);
      if (filtered.length === 0) {
        setCrashesError('이 이슈와 연결된 크래시 리포트가 없습니다.');
      }
    } catch (e: unknown) {
      setCrashesError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingCrashes(false);
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
    } catch (e: unknown) {
      setStatusMsg(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const selectedSoftwareName = softwares.find((s) => s.id === selectedSoftwareId)?.name ?? '';

  return (
    <div className="jira-issues">
      <div className="page-header">
        <div>
          <h1>Jira Issues</h1>
          <p className="page-subtitle">Sprint 이슈 기반 크래시 조회 및 분석</p>
        </div>
      </div>

      <div className="ji-filter-bar">
        <div className="filter-group">
          <label>Software</label>
          <select
            value={selectedSoftwareId}
            onChange={(e) => setSelectedSoftwareId(Number(e.target.value))}
          >
            <option value={0}>-- Select --</option>
            {softwares.map((sw) => (
              <option key={sw.id} value={sw.id}>{sw.name}</option>
            ))}
          </select>
        </div>
        {sprintId && (
          <div className="ji-sprint-badge">
            <Ticket size={13} />
            Sprint #{sprintId}
          </div>
        )}
        <button
          className="btn btn-primary"
          onClick={loadSprintIssues}
          disabled={loadingIssues || selectedSoftwareId === 0}
        >
          <RefreshCw size={16} className={loadingIssues ? 'spinning' : ''} />
          {loadingIssues ? 'Loading...' : 'Refresh'}
        </button>
      </div>

      {statusMsg && <div className="status-bar"><span>{statusMsg}</span></div>}

      {selectedSoftwareId === 0 ? (
        <div className="ji-empty-root">
          <Ticket size={48} />
          <h3>소프트웨어를 선택하세요</h3>
          <p>소프트웨어를 선택하면 해당 Sprint의 Jira 이슈 목록이 표시됩니다.</p>
        </div>
      ) : (
        <div className="ji-content">
          <div className="ji-issues-panel">
            <div className="ji-panel-header">
              <h2>
                Sprint Issues
                {issues.length > 0 && <span className="ji-count">{issues.length}</span>}
              </h2>
              {selectedSoftwareName && <span className="ji-sw-name">{selectedSoftwareName}</span>}
            </div>

            {loadingIssues && (
              <div className="ji-loading">
                <Loader size={20} className="spinning" />
                <span>Jira에서 스프린트 이슈를 불러오는 중...</span>
              </div>
            )}

            {!loadingIssues && issuesError && (
              <div className="ji-error-banner">
                <AlertTriangle size={14} />
                {issuesError}
              </div>
            )}

            {!loadingIssues && issues.length > 0 && (
              <div className="ji-issue-list">
                {issues.map((issue) => (
                  <div key={issue.key} className="ji-issue-item-wrap">
                    <button
                      className={`ji-issue-row ${selectedIssueKey === issue.key ? 'active' : ''}`}
                      onClick={() => loadCrashesForIssue(issue.key)}
                    >
                      <span className="ji-chevron">
                        {selectedIssueKey === issue.key
                          ? <ChevronDown size={14} />
                          : <ChevronRight size={14} />}
                      </span>
                      <span className={`ji-issue-type ji-type-${issue.issueType.toLowerCase().replace(/\s/g, '-')}`}>
                        {issue.issueType}
                      </span>
                      <a
                        className="ji-issue-key"
                        href={`${jiraUrl.replace(/\/$/, '')}/browse/${issue.key}`}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {issue.key}
                      </a>
                      <span className="ji-issue-summary">{issue.summary}</span>
                      <span className={`ji-status-badge ji-status-${issue.status.toLowerCase().replace(/\s/g, '-')}`}>
                        {issue.status}
                      </span>
                    </button>

                    {selectedIssueKey === issue.key && (
                      <div className="ji-crashes-panel">
                        {loadingCrashes && (
                          <div className="ji-loading ji-loading-sm">
                            <Loader size={14} className="spinning" />
                            <span>크래시 리포트 조회 중...</span>
                          </div>
                        )}

                        {!loadingCrashes && crashesError && (
                          <div className="ji-error-banner ji-error-sm">
                            <AlertTriangle size={13} />
                            {crashesError}
                          </div>
                        )}

                        {!loadingCrashes && crashes.length > 0 && (
                          <table className="ji-crash-table">
                            <thead>
                              <tr>
                                <th>#</th>
                                <th>Subject</th>
                                <th>Version</th>
                                <th>OS</th>
                                <th>Date</th>
                                <th>Status</th>
                                <th>Action</th>
                              </tr>
                            </thead>
                            <tbody>
                              {crashes.map((crash) => (
                                <tr
                                  key={crash.id}
                                  className="ji-crash-row"
                                  onClick={() => navigate(`/crash/${crash.id}`)}
                                >
                                  <td className="ji-crash-id">{crash.id}</td>
                                  <td className="ji-crash-subject">{crash.subject}</td>
                                  <td><code className="branch-tag">{crash.swVersion}</code></td>
                                  <td>
                                    {crash.osType === 'windows' ? '🪟 Win'
                                      : crash.osType === 'macos' ? '🍎 Mac'
                                      : '—'}
                                  </td>
                                  <td className="ji-crash-date">
                                    {new Date(crash.receivedAt).toLocaleDateString('ko-KR', {
                                      month: 'short', day: 'numeric',
                                      hour: '2-digit', minute: '2-digit',
                                    })}
                                  </td>
                                  <td><StatusBadge status={crash.status} /></td>
                                  <td onClick={(e) => e.stopPropagation()}>
                                    {historyIds.has(crash.id) ? (
                                      <div className="action-group">
                                        <button
                                          className="btn btn-sm btn-info"
                                          onClick={() => navigate(`/crash/${crash.id}`)}
                                        >
                                          <Info size={13} /> View
                                        </button>
                                        <button
                                          className="btn btn-sm btn-ghost"
                                          onClick={(e) => clearHistory(e, crash.id)}
                                          title="Clear history"
                                        >
                                          <Trash2 size={13} />
                                        </button>
                                      </div>
                                    ) : (
                                      <>
                                        {crash.status === 'new' && (
                                          <button
                                            className="btn btn-sm btn-accent"
                                            onClick={() => runPipeline(crash)}
                                          >
                                            <Play size={13} /> Run
                                          </button>
                                        )}
                                        {(['analyzing', 'fixing', 'creating_pr'] as CrashStatus[]).includes(crash.status) && (
                                          <button
                                            className="btn btn-sm btn-running"
                                            onClick={() => navigate(`/crash/${crash.id}`)}
                                          >
                                            <Loader size={13} className="spinning" /> Pipeline...
                                          </button>
                                        )}
                                        {crash.analysis?.prUrl && (
                                          <a
                                            href={crash.analysis.prUrl}
                                            target="_blank"
                                            rel="noreferrer"
                                            className="btn btn-sm btn-success"
                                          >
                                            View PR
                                          </a>
                                        )}
                                      </>
                                    )}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
