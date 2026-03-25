import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Play, Square, RefreshCw, CheckCircle, AlertTriangle, Link2, Plus, ChevronDown, ChevronUp, ExternalLink, Trash2 } from 'lucide-react';
import { apiGet, apiPost, apiDelete } from '../hooks/useApi';
import { useSocket } from '../hooks/useSocket';
import type { ApiSoftware, ClassificationRun, ClassificationResult, ClassificationVerdict } from '../types';
import './Classification.css';

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

const VERDICT_META: Record<ClassificationVerdict, { label: string; color: string; icon: React.ReactNode }> = {
  validated:     { label: '올바른 매핑',    color: 'validated',     icon: <CheckCircle size={14} /> },
  misclassified: { label: '잘못된 매핑',    color: 'misclassified', icon: <AlertTriangle size={14} /> },
  assign:        { label: '이슈 매핑 필요', color: 'assign',        icon: <Link2 size={14} /> },
  new_issue:     { label: '신규 이슈 필요', color: 'new_issue',     icon: <Plus size={14} /> },
  no_stack:      { label: '분석 불가 (스택 없음)', color: 'no_stack', icon: <AlertTriangle size={14} /> },
};

function VerdictBadge({ verdict }: { verdict: ClassificationVerdict }) {
  const meta = VERDICT_META[verdict];
  return (
    <span className={`verdict-badge verdict-${meta.color}`}>
      {meta.icon}
      {meta.label}
    </span>
  );
}

function ConfidenceDot({ confidence }: { confidence: 'high' | 'medium' | 'low' }) {
  return <span className={`confidence-dot confidence-${confidence}`} title={`신뢰도: ${confidence}`} />;
}

// ─────────────────────────────────────────────────────────────────────────
// Result Row
// ─────────────────────────────────────────────────────────────────────────

function ResultRow({ result, jiraUrl, crashServerUrl }: { result: ClassificationResult; jiraUrl: string; crashServerUrl: string }) {
  const [open, setOpen] = useState(false);

  const issueHref = (key: string) =>
    jiraUrl ? `${jiraUrl.replace(/\/$/, '')}/browse/${key}` : '#';

  return (
    <div className={`result-row verdict-border-${result.verdict}`}>
      <div className="result-row-header" onClick={() => setOpen((v) => !v)}>
        <div className="result-row-left">
          <VerdictBadge verdict={result.verdict} />
          <ConfidenceDot confidence={result.confidence} />
          <Link
            to={`/crash/${result.crashId}`}
            className="result-crash-link"
            onClick={(e) => e.stopPropagation()}
          >
            #{result.crashId}
          </Link>
          {crashServerUrl && (
            <a
              href={`${crashServerUrl}/reports/${result.crashId}`}
              target="_blank"
              rel="noreferrer"
              className="detail-ext-link"
              title="View in CrashOrganizer"
              onClick={(e) => e.stopPropagation()}
            >
              <ExternalLink size={12} />
              CrashOrganizer
            </a>
          )}
          <span className="result-subject">{result.crashSubject}</span>
          {result.exceptionCode && (
            <code className="result-exception">{result.exceptionCode}</code>
          )}
        </div>
        <div className="result-row-right">
          {result.currentIssueKey && (
            <a
              href={issueHref(result.currentIssueKey)}
              target="_blank"
              rel="noreferrer"
              className="issue-key-link"
              onClick={(e) => e.stopPropagation()}
            >
              {result.currentIssueKey}
              <ExternalLink size={11} />
            </a>
          )}
          {(result.verdict === 'misclassified' || result.verdict === 'assign') && result.suggestedIssueKey && (
            <span className="issue-arrow">→</span>
          )}
          {result.suggestedIssueKey && (
            <a
              href={issueHref(result.suggestedIssueKey)}
              target="_blank"
              rel="noreferrer"
              className="issue-key-link suggested"
              onClick={(e) => e.stopPropagation()}
            >
              {result.suggestedIssueKey}
              <ExternalLink size={11} />
            </a>
          )}
          {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </div>
      </div>

      {open && (
        <div className="result-row-detail">
          <div className="detail-section">
            <span className="detail-label">이유</span>
            <span className="detail-value">{result.reason}</span>
          </div>
          <div className="detail-section">
            <span className="detail-label">Stack Fingerprint</span>
            <code className="detail-fingerprint">{result.fingerprint}</code>
          </div>
          {result.suggestedIssueSummary && (
            <div className="detail-section">
              <span className="detail-label">
                {result.verdict === 'misclassified' ? '올바른 이슈' : '매칭된 이슈'}
              </span>
              <span className="detail-value">{result.suggestedIssueSummary}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Main page
// ─────────────────────────────────────────────────────────────────────────

export default function Classification() {
  const [softwares, setSoftwares] = useState<ApiSoftware[]>([]);
  const [softwareId, setSoftwareId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [jiraUrl, setJiraUrl] = useState('');
  const [crashServerUrl, setCrashServerUrl] = useState('');
  const [jiraConfigured, setJiraConfigured] = useState(false);

  const [strict, setStrict] = useState(false);
  const [running, setRunning] = useState(false);
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ current: number; total: number; message: string } | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [results, setResults] = useState<ClassificationResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [history, setHistory] = useState<ClassificationRun[]>([]);
  const [selectedRun, setSelectedRun] = useState<ClassificationRun | null>(null);
  const [filterVerdict, setFilterVerdict] = useState<ClassificationVerdict | ''>('');

  const logsBoxRef = useRef<HTMLDivElement>(null);
  const socketRef = useSocket();

  // 초기 데이터 로드
  useEffect(() => {
    apiGet<ApiSoftware[]>('/config/softwares').then(setSoftwares).catch(() => {});
    apiGet<{ jiraConfigured: boolean }>('/classification/status')
      .then(({ jiraConfigured }) => setJiraConfigured(jiraConfigured))
      .catch(() => {});
    apiGet<{ jira?: { url: string }; crashReportServer?: { url: string } }>('/config')
      .then((cfg) => {
        if (cfg.jira?.url) setJiraUrl(cfg.jira.url);
        if (cfg.crashReportServer?.url) {
          const apiUrl = new URL(cfg.crashReportServer.url.replace(/\/$/, ''));
          apiUrl.port = '5000';
          setCrashServerUrl(apiUrl.origin);
        }
      })
      .catch(() => {});
    loadHistory();

    // 기본 날짜: 오늘 기준 -7일 ~ 오늘
    const today = new Date();
    const week = new Date(today);
    week.setDate(today.getDate() - 7);
    setEndDate(today.toISOString().slice(0, 10));
    setStartDate(week.toISOString().slice(0, 10));
  }, []);

  // Socket 이벤트
  useEffect(() => {
    const socket = socketRef.current;
    if (!socket) return;

    const onLog = ({ runId, message }: any) => {
      if (runId !== currentRunId) return;
      setLogs((prev) => [...prev.slice(-200), message]);
    };
    const onProgress = ({ runId, current, total, message }: any) => {
      if (runId !== currentRunId) return;
      setProgress({ current, total, message });
    };
    const onComplete = ({ runId, results: r }: any) => {
      if (runId !== currentRunId) return;
      setResults(r);
      setRunning(false);
      setProgress(null);
      loadHistory();
    };
    const onError = ({ runId, message }: any) => {
      if (runId !== currentRunId) return;
      setError(message);
      setRunning(false);
      setProgress(null);
    };

    socket.on('classification:log', onLog);
    socket.on('classification:progress', onProgress);
    socket.on('classification:complete', onComplete);
    socket.on('classification:error', onError);

    return () => {
      socket.off('classification:log', onLog);
      socket.off('classification:progress', onProgress);
      socket.off('classification:complete', onComplete);
      socket.off('classification:error', onError);
    };
  }, [socketRef, currentRunId]);

  // 로그 자동 스크롤 (log-box 내부만 스크롤, 페이지 스크롤 유지)
  useEffect(() => {
    const box = logsBoxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [logs]);

  const loadHistory = () => {
    apiGet<ClassificationRun[]>('/classification/history').then(setHistory).catch(() => {});
  };

  const runClassification = async () => {
    if (!softwareId || !startDate || !endDate) return;
    setRunning(true);
    setError(null);
    setResults(null);
    setLogs([]);
    setProgress(null);
    try {
      const { runId } = await apiPost<{ runId: string }>('/classification/run', {
        softwareId: Number(softwareId),
        startDate,
        endDate,
        strict,
      });
      setCurrentRunId(runId);
    } catch (e: any) {
      setError(e.message);
      setRunning(false);
    }
  };

  const cancelClassification = async () => {
    if (!currentRunId) return;
    await apiPost(`/classification/cancel/${currentRunId}`).catch(() => {});
    setRunning(false);
  };

  const deleteRun = async (e: React.MouseEvent, runId: string) => {
    e.stopPropagation();
    await apiDelete(`/classification/history/${runId}`).catch(() => {});
    setHistory((prev) => prev.filter((r) => r.id !== runId));
    if (selectedRun?.id === runId) { setSelectedRun(null); setResults(null); }
  };

  const clearAllHistory = async () => {
    await apiDelete('/classification/history').catch(() => {});
    setHistory([]);
    setSelectedRun(null);
    setResults(null);
  };

  const loadRunResults = async (run: ClassificationRun) => {
    const full = await apiGet<ClassificationRun>(`/classification/results/${run.id}`);
    setSelectedRun(full);
    setResults(full.results);
    setCurrentRunId(full.id);
  };

  const displayResults = results ?? [];
  const filtered = filterVerdict
    ? displayResults.filter((r) => r.verdict === filterVerdict)
    : displayResults;

  const counts = {
    validated: displayResults.filter((r) => r.verdict === 'validated').length,
    misclassified: displayResults.filter((r) => r.verdict === 'misclassified').length,
    assign: displayResults.filter((r) => r.verdict === 'assign').length,
    new_issue: displayResults.filter((r) => r.verdict === 'new_issue').length,
    no_stack: displayResults.filter((r) => r.verdict === 'no_stack').length,
  };

  return (
    <div className="classification">
      <div className="page-header">
        <div>
          <h1>Crash Classification</h1>
          <p className="page-subtitle">
            날짜 범위로 크래시를 조회하여 Jira 이슈 매핑이 올바른지 검증하고, 미분류 크래시를 분류합니다.
          </p>
        </div>
      </div>

      {!jiraConfigured && (
        <div className="warning-banner">
          <AlertTriangle size={16} />
          Jira가 설정되지 않았습니다. <Link to="/settings">Settings</Link>에서 Jira URL, Email, API Token을 입력하면 더 정확한 분류가 가능합니다.
        </div>
      )}

      <div className="classification-layout">
        {/* 좌측: 컨트롤 + 히스토리 */}
        <div className="classification-sidebar">
          {/* 실행 패널 */}
          <div className="panel">
            <h3>분류 실행</h3>
            <div className="field">
              <label>소프트웨어</label>
              <select value={softwareId} onChange={(e) => setSoftwareId(e.target.value)} disabled={running}>
                <option value="">선택...</option>
                {softwares.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>시작 날짜</label>
              <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} disabled={running} />
            </div>
            <div className="field">
              <label>종료 날짜</label>
              <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} disabled={running} />
            </div>

            <div className="field">
              <label>검증 모드</label>
              <button
                className={`strict-toggle ${strict ? 'strict-on' : 'strict-off'}`}
                onClick={() => setStrict((v) => !v)}
                disabled={running}
                type="button"
              >
                <span className="strict-toggle-indicator" />
                <span>{strict ? 'Strict' : 'Lenient'}</span>
              </button>
              <p className="strict-desc">
                {strict
                  ? 'OS·스택이 일치해야 validated 판정'
                  : 'call stack 흐름·모듈 등을 종합 고려 — 가능성 있으면 validated'}
              </p>
            </div>

            {!running ? (
              <button
                className="btn btn-primary btn-full"
                onClick={runClassification}
                disabled={!softwareId || !startDate || !endDate}
              >
                <Play size={16} />
                분류 실행
              </button>
            ) : (
              <button className="btn btn-danger btn-full" onClick={cancelClassification}>
                <Square size={16} />
                중단
              </button>
            )}
          </div>

          {/* 히스토리 */}
          <div className="panel">
            <div className="panel-header">
              <h3>히스토리</h3>
              <div style={{ display: 'flex', gap: '4px' }}>
                <button className="btn-icon" onClick={loadHistory} title="새로고침">
                  <RefreshCw size={14} />
                </button>
                <button className="btn-icon btn-icon-danger" onClick={clearAllHistory} title="전체 삭제" disabled={history.length === 0}>
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
            {history.length === 0 ? (
              <p className="empty-text">실행 기록 없음</p>
            ) : (
              <ul className="history-list">
                {history.map((run) => (
                  <li
                    key={run.id}
                    className={`history-item ${selectedRun?.id === run.id ? 'active' : ''}`}
                    onClick={() => loadRunResults(run)}
                  >
                    <div className="history-item-title">{run.softwareName ?? `ID:${run.softwareId}`}</div>
                    <div className="history-item-sub">
                      {run.startDate} ~ {run.endDate}
                    </div>
                    <div className="history-item-meta">
                      <span className={`status-dot status-${run.status}`} />
                      {run.processedCrashes}/{run.totalCrashes}건
                      <button className="btn-icon btn-icon-danger" onClick={(e) => deleteRun(e, run.id)} title="삭제">
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* 우측: 진행 상황 + 결과 */}
        <div className="classification-main">
          {/* 진행 상황 */}
          {running && (
            <div className="panel progress-panel">
              <h3>진행 중...</h3>
              {progress && (
                <div className="progress-bar-wrap">
                  <div
                    className="progress-bar-fill"
                    style={{ width: `${progress.total > 0 ? (progress.current / progress.total) * 100 : 0}%` }}
                  />
                  <span className="progress-text">{progress.message} ({progress.current}/{progress.total})</span>
                </div>
              )}
              <div className="log-box" ref={logsBoxRef}>
                {logs.map((line, i) => <div key={i} className="log-line">{line}</div>)}
              </div>
            </div>
          )}

          {error && (
            <div className="error-banner">
              <AlertTriangle size={16} />
              {error}
            </div>
          )}

          {/* 결과 */}
          {results !== null && (
            <div className="panel results-panel">
              <div className="results-header">
                <h3>분류 결과 ({displayResults.length}건)</h3>
                <div className="results-summary">
                  {(Object.keys(VERDICT_META) as ClassificationVerdict[]).map((v) => (
                    <button
                      key={v}
                      className={`summary-chip verdict-${v} ${filterVerdict === v ? 'active' : ''}`}
                      onClick={() => setFilterVerdict((prev) => prev === v ? '' : v)}
                    >
                      {VERDICT_META[v].icon}
                      {counts[v]}
                    </button>
                  ))}
                </div>
              </div>

              {filtered.length === 0 ? (
                <p className="empty-text">해당 판정 결과 없음</p>
              ) : (
                <div className="results-list">
                  {filtered.map((r) => (
                    <ResultRow key={r.crashId} result={r} jiraUrl={jiraUrl} crashServerUrl={crashServerUrl} />
                  ))}
                </div>
              )}
            </div>
          )}

          {results === null && !running && (
            <div className="panel empty-panel">
              <p>좌측에서 소프트웨어와 날짜 범위를 선택하고 분류 실행을 눌러주세요.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
