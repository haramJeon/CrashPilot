import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Play, Square, ExternalLink, FileCode, Info, Bot, Pencil, Search, Loader, Check, X, AlertTriangle } from 'lucide-react';
import { useSocket } from '../hooks/useSocket';
import { apiGet, apiPost, apiPatch } from '../hooks/useApi';
import StatusBadge from '../components/StatusBadge';
import PipelineView from '../components/PipelineView';
import type { CrashReport, PipelineStep, CrashAnalysis, PipelineRunHistory, PipelinePreAnalysis, AppConfig } from '../types';
import './CrashDetail.css';

interface RemoteRef { name: string; short: string; type: 'branch' | 'tag'; }

export default function CrashDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [crash, setCrash] = useState<CrashReport | null>(null);
  const [config, setConfig] = useState<Pick<AppConfig, 'crashReportServer' | 'jira'> | null>(null);
  const [steps, setSteps] = useState<PipelineStep[]>([]);
  const [analysis, setAnalysis] = useState<CrashAnalysis | null>(null);
  const [customPrompt, setCustomPrompt] = useState('');
  const [history, setHistory] = useState<PipelineRunHistory | null>(null);
  const [preAnalysis, setPreAnalysis] = useState<PipelinePreAnalysis | null>(null);
  const [refMatches, setRefMatches] = useState<RemoteRef[]>([]);
  const [refSearching, setRefSearching] = useState(false);
  const [refEditing, setRefEditing] = useState(false);
  const [refError, setRefError] = useState('');
  // PR base branch (resolved from tag → branch mapping)
  const [prBaseBranch, setPrBaseBranch] = useState<string | null>(null);
  const [prBaseEditing, setPrBaseEditing] = useState(false);
  const [prBaseInput, setPrBaseInput] = useState('');
  const [prBaseLoading, setPrBaseLoading] = useState(false);
  const socketRef = useSocket();
  const socketReceivedRef = useRef(false);

  const loadPrBaseBranch = async (tag: string, swName?: string) => {
    if (!tag) return;
    setPrBaseLoading(true);
    try {
      let url = `/git/pr-base-branch?tag=${encodeURIComponent(tag)}`;
      if (swName) url += `&swName=${encodeURIComponent(swName)}`;
      const res = await apiGet<{ branch: string | null }>(url);
      setPrBaseBranch(res.branch);
      setPrBaseInput(res.branch ?? '');
    } catch { /* ignore */ } finally {
      setPrBaseLoading(false);
    }
  };

  useEffect(() => {
    if (!id) return;

    socketReceivedRef.current = false;

    apiGet<AppConfig>('/config').then((c) => setConfig(c)).catch(() => {});

    apiGet<CrashReport>(`/crash/${id}`).then((data) => {
      setCrash(data);
      if (!socketReceivedRef.current && data.pipelineSteps?.length) setSteps(data.pipelineSteps);
      if (data.analysis) setAnalysis(data.analysis);
      if (data.releaseTag) loadPrBaseBranch(data.releaseTag, data.softwareName);
    }).catch(() => {});

    apiGet<PipelineRunHistory>(`/pipeline/history/${id}`).then((h) => {
      setHistory(h);
      if (!socketReceivedRef.current) setSteps(h.steps);
      if (h.analysis) setAnalysis(h.analysis);
      if (h.preAnalysis) setPreAnalysis(h.preAnalysis);
    }).catch(() => {});

    const socket = socketRef.current;
    if (!socket) return;

    socket.on('pipeline:steps', (data: { crashId: string; steps: PipelineStep[] }) => {
      if (data.crashId === id) {
        socketReceivedRef.current = true;
        setSteps(data.steps);
      }
    });

    socket.on('pipeline:pre_analysis', (data: { crashId: string; preAnalysis: PipelinePreAnalysis }) => {
      if (data.crashId === id) setPreAnalysis(data.preAnalysis ?? null);
    });

    socket.on('pipeline:complete', (data: { crashId: string; analysis: CrashAnalysis }) => {
      if (data.crashId === id) {
        setAnalysis(data.analysis);
        apiGet<PipelineRunHistory>(`/pipeline/history/${id}`).then(setHistory).catch(() => {});
      }
    });

    socket.on('pipeline:error', (data: { crashId: string }) => {
      if (data.crashId === id) {
        apiGet<PipelineRunHistory>(`/pipeline/history/${id}`).then(setHistory).catch(() => {});
      }
    });

    return () => {
      socket.off('pipeline:steps');
      socket.off('pipeline:pre_analysis');
      socket.off('pipeline:complete');
      socket.off('pipeline:error');
    };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const searchRefs = async (swVersion: string) => {
    setRefSearching(true);
    setRefError('');
    setRefMatches([]);
    try {
      const refs = await apiGet<RemoteRef[]>(`/git/refs/match?version=${encodeURIComponent(swVersion)}`);
      const sorted = [...refs.filter((r) => r.type === 'tag'), ...refs.filter((r) => r.type === 'branch')];
      setRefMatches(sorted);
      if (sorted.length === 0) setRefError(`No refs found for "${swVersion}"`);
      else if (sorted.length === 1) pickRef(sorted[0]);  // auto-select if only one
    } catch (e: any) {
      setRefError(e.message || 'Search failed');
    } finally {
      setRefSearching(false);
    }
  };

  const pickRef = async (ref: RemoteRef) => {
    if (!crash) return;
    const updated = await apiPatch<CrashReport>(`/crash/${crash.id}`, { releaseTag: ref.short }).catch(() => null);
    if (updated) setCrash(updated);
    else setCrash((c) => c ? { ...c, releaseTag: ref.short } : c);
    setRefEditing(false);
    setRefMatches([]);
    loadPrBaseBranch(ref.short, crash?.softwareName);
  };

  const savePrBaseBranch = async () => {
    if (!crash?.releaseTag || !prBaseInput.trim()) return;
    try {
      await apiPost('/git/pr-base-branch', { tag: crash.releaseTag, branch: prBaseInput.trim() });
      setPrBaseBranch(prBaseInput.trim());
      setPrBaseEditing(false);
    } catch (e: any) { console.error(e); }
  };


  const hasStack = (crash?.stackTraces?.length ?? 0) > 0 || (crash?.mainStackTraces?.length ?? 0) > 0;
  const isRunning = socketReceivedRef.current && steps.some((s) => s.status === 'running');
  const isAwaitingAI = socketReceivedRef.current && steps.some((s) => s.status === 'awaiting');

  const stopPipeline = async () => {
    if (!crash) return;
    try { await apiPost(`/pipeline/cancel/${crash.id}`, {}); } catch (e: any) { console.error(e); }
  };

  const runPipeline = async () => {
    if (!crash) return;
    try {
      setHistory(null);
      setSteps([]);
      setAnalysis(null);
      setPreAnalysis(null);
      const payload = (!crash.releaseTag && history?.releaseTag)
        ? { ...crash, releaseTag: history.releaseTag }
        : crash;
      await apiPost(`/pipeline/run/${crash.id}`, payload);
    } catch (e: any) { console.error(e); }
  };

  const runAI = async () => {
    if (!crash) return;
    try { await apiPost(`/pipeline/run-ai/${crash.id}`, { customPrompt: customPrompt.trim() || undefined }); } catch (e) { console.error(e); }
  };

  const retryStep = async (stepIdx: number) => {
    if (!crash) return;
    try {
      const result = await apiPost<{ action: string }>(`/pipeline/retry/${crash.id}/${stepIdx}`, {});
      if (result.action === 'rerun') {
        await runPipeline();
      }
    } catch (e: any) {
      console.error(e);
      alert(`Retry failed: ${e.message}`);
    }
  };

  if (!crash) {
    return (
      <div className="detail-loading">
        <p>Loading crash details...</p>
      </div>
    );
  }

  return (
    <div className="crash-detail">
      <button className="btn-back" onClick={() => navigate('/')}>
        <ArrowLeft size={16} />
        Back to Dashboard
      </button>

      <div className="detail-header">
        <div>
          <h1>{crash.subject}</h1>
          <div className="detail-meta">
            <span>Version: <code className="branch-tag">{crash.swVersion}</code></span>

            {/* Release tag selector — controls checkout, not PR */}
            <span className="ref-selector-wrap">
              Tag:&nbsp;
              {refEditing ? (
                <span className="ref-selector">
                  <button className="branch-btn" onClick={() => searchRefs(crash.swVersion)} disabled={refSearching} title="Search matching refs">
                    {refSearching ? <Loader size={12} className="spinning" /> : <Search size={12} />}
                  </button>
                  <button className="branch-btn branch-btn-cancel" onClick={() => { setRefEditing(false); setRefMatches([]); setRefError(''); }} title="Cancel">
                    <X size={12} />
                  </button>
                  {refMatches.length > 0 && (
                    <div className="branch-matches">
                      {refMatches.map((ref) => (
                        <button key={ref.name} className="branch-match-item" onClick={() => pickRef(ref)}>
                          <span className={`ref-type ref-type-${ref.type}`}>{ref.type}</span>
                          <span className="ref-name">{ref.short}</span>
                          <Check size={12} className="ref-pick-icon" />
                        </button>
                      ))}
                    </div>
                  )}
                  {refError && <span className="branch-search-error">{refError}</span>}
                </span>
              ) : (
                <span className="ref-display">
                  <code className="branch-tag">{crash.releaseTag || '—'}</code>
                  <button className="branch-edit-btn" onClick={() => { setRefEditing(true); searchRefs(crash.swVersion); }} title="Change branch/tag">
                    <Pencil size={12} />
                  </button>
                </span>
              )}
            </span>

            {/* PR base branch — auto-detected from tag, used only for PR creation */}
            {crash.releaseTag && (
              <span className="ref-selector-wrap">
                Branch:&nbsp;
                {prBaseEditing ? (
                  <span className="ref-selector">
                    <input
                      className="pr-base-input"
                      value={prBaseInput}
                      onChange={(e) => setPrBaseInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') savePrBaseBranch(); if (e.key === 'Escape') setPrBaseEditing(false); }}
                      autoFocus
                    />
                    <button className="branch-btn" onClick={savePrBaseBranch} title="Save"><Check size={12} /></button>
                    <button className="branch-btn branch-btn-cancel" onClick={() => setPrBaseEditing(false)} title="Cancel"><X size={12} /></button>
                  </span>
                ) : (
                  <span className="ref-display">
                    {prBaseLoading
                      ? <Loader size={12} className="spinning" />
                      : <code className="branch-tag">{prBaseBranch ?? '—'}</code>}
                    <button className="branch-edit-btn" onClick={() => setPrBaseEditing(true)} title="Edit PR base branch"><Pencil size={12} /></button>
                  </span>
                )}
              </span>
            )}

            <span>{crash.region || ''}</span>
            <span>{new Date(crash.receivedAt).toLocaleString('ko-KR')}</span>
            {config && (() => {
              const apiUrl = new URL(config.crashReportServer.url.replace(/\/$/, ''));
              apiUrl.port = '5000';
              const organizerBase = apiUrl.origin;
              return (
                <span className="detail-ext-links">
                  <a
                    href={`${organizerBase}/reports/${crash.id}`}
                    target="_blank"
                    rel="noreferrer"
                    className="detail-ext-link"
                    title="View in CrashOrganizer"
                  >
                    <ExternalLink size={13} />
                    CrashOrganizer
                  </a>
                  {config.jira?.url && crash.issueKey && crash.issueKey !== 'None' && (
                    <a
                      href={`${config.jira.url.replace(/\/$/, '')}/browse/${crash.issueKey}`}
                      target="_blank"
                      rel="noreferrer"
                      className="detail-ext-link detail-ext-link-jira"
                      title="View Jira issue"
                    >
                      <ExternalLink size={13} />
                      {crash.issueKey}
                    </a>
                  )}
                </span>
              );
            })()}
          </div>
        </div>
        <div className="detail-actions">
          <StatusBadge status={crash.status} />
          {!hasStack && <span className="no-stack-badge"><AlertTriangle size={14} />분석 불가 (스택 없음)</span>}
          {isRunning ? (
            <button className="btn btn-danger" onClick={stopPipeline}>
              <Square size={16} />
              Stop
            </button>
          ) : isAwaitingAI ? (
            <button className="btn btn-ai" onClick={runAI}>
              <Bot size={16} />
              Fix by AI
            </button>
          ) : history ? (
            <>
              <span className="history-badge">
                <Info size={14} />
                {new Date(history.runAt).toLocaleString('ko-KR')} 실행 결과
              </span>
              <button className="btn btn-primary" onClick={runPipeline}>
                <Play size={16} />
                Re-run
              </button>
            </>
          ) : (
            <button className="btn btn-primary" onClick={runPipeline}>
              <Play size={16} />
              Run Pipeline
            </button>
          )}
        </div>
      </div>

      <div className="detail-grid">
        {steps.length > 0 && (
          <div className="detail-card">
            <h3>Pipeline Progress</h3>

            {isAwaitingAI && (
              <>
                {preAnalysis && (
                  <div className="pre-analysis-box">
                    <div className="pre-analysis-title">
                      <Bot size={14} />
                      Crash Pre-Analysis
                    </div>
                    <div className="pre-analysis-grid">
                      {preAnalysis.crashLocation && (
                        <div className="pre-analysis-row">
                          <span className="pre-analysis-label">크래시 위치</span>
                          <code className="pre-analysis-value-code">{preAnalysis.crashLocation}</code>
                        </div>
                      )}
                      {preAnalysis.bugType && (
                        <div className="pre-analysis-row">
                          <span className="pre-analysis-label">버그 유형</span>
                          <span className="pre-analysis-value">{preAnalysis.bugType}</span>
                        </div>
                      )}
                      {preAnalysis.rootCause && (
                        <div className="pre-analysis-row">
                          <span className="pre-analysis-label">근본 원인</span>
                          <span className="pre-analysis-value">{preAnalysis.rootCause}</span>
                        </div>
                      )}
                      {preAnalysis.hints && (
                        <div className="pre-analysis-row">
                          <span className="pre-analysis-label">수정 힌트</span>
                          <span className="pre-analysis-value pre-analysis-hints">{preAnalysis.hints}</span>
                        </div>
                      )}
                    </div>
                    <p className="pre-analysis-confirm">위 분석을 바탕으로 소스코드를 수정하시겠습니까?</p>
                  </div>
                )}
                <div className="ai-prompt-box">
                  <label className="ai-prompt-label">Custom prompt (optional — overrides default crash analysis query)</label>
                  <textarea
                    className="ai-prompt-textarea"
                    rows={5}
                    placeholder="Leave empty to use the default prompt, or enter a custom query to send directly to Claude..."
                    value={customPrompt}
                    onChange={(e) => setCustomPrompt(e.target.value)}
                  />
                </div>
              </>
            )}
            <PipelineView steps={steps} onRunAI={isAwaitingAI ? runAI : undefined} onRetry={retryStep} />
          </div>
        )}

        <div className="detail-card">
          <h3>Dump File</h3>
          <a href={crash.dumpUrl} target="_blank" rel="noreferrer" className="dump-link">
            <ExternalLink size={14} />
            {crash.dumpUrl}
          </a>
        </div>

        {analysis && (
          <>
            <div className="detail-card">
              <h3>Exception Info</h3>
              <div className="info-grid">
                <div className="info-item">
                  <span className="info-label">Type</span>
                  <span className="info-value">{analysis.exceptionType}</span>
                </div>
                <div className="info-item">
                  <span className="info-label">S/N</span>
                  <span className="info-value">{crash.serialNo || '—'}</span>
                </div>
              </div>
            </div>

            <div className="detail-card">
              <h3>Call Stack</h3>
              <pre className="code-block">{analysis.callStack}</pre>
            </div>

            <div className="detail-card">
              <h3>Root Cause Analysis</h3>
              <p className="analysis-text">{analysis.rootCause}</p>
            </div>

            <div className="detail-card">
              <h3>Suggested Fix</h3>
              <p className="analysis-text">{analysis.suggestedFix}</p>
            </div>

            {analysis.fixedFiles.length > 0 && (
              <div className="detail-card">
                <h3>
                  <FileCode size={18} />
                  Changed Files ({analysis.fixedFiles.length})
                </h3>
                {analysis.fixedFiles.map((file, idx) => (
                  <div key={idx} className="file-diff">
                    <div className="file-path">{file.path}</div>
                  </div>
                ))}
              </div>
            )}

            {analysis.prUrl && (
              <div className="detail-card pr-card">
                <h3>Pull Request</h3>
                {analysis.prUrl.split('\n').filter(Boolean).map((url, i) => (
                  <a key={i} href={url} target="_blank" rel="noreferrer" className="pr-link">
                    <ExternalLink size={16} />
                    {url}
                  </a>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
