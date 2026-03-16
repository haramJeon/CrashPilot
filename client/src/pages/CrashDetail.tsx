import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Play, Square, ExternalLink, FileCode, Info, Bot } from 'lucide-react';
import { useSocket } from '../hooks/useSocket';
import { apiGet, apiPost } from '../hooks/useApi';
import StatusBadge from '../components/StatusBadge';
import PipelineView from '../components/PipelineView';
import type { CrashReport, PipelineStep, CrashAnalysis, PipelineRunHistory } from '../types';
import './CrashDetail.css';

export default function CrashDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [crash, setCrash] = useState<CrashReport | null>(null);
  const [steps, setSteps] = useState<PipelineStep[]>([]);
  const [analysis, setAnalysis] = useState<CrashAnalysis | null>(null);
  const [history, setHistory] = useState<PipelineRunHistory | null>(null);
  const socketRef = useSocket();

  useEffect(() => {
    if (!id) return;

    apiGet<CrashReport>(`/crash/${id}`).then((data) => {
      setCrash(data);
      if (data.pipelineSteps?.length) setSteps(data.pipelineSteps);
      if (data.analysis) setAnalysis(data.analysis);
    }).catch(() => {});

    apiGet<PipelineRunHistory>(`/pipeline/history/${id}`).then((h) => {
      setHistory(h);
      setSteps(h.steps);
      if (h.analysis) setAnalysis(h.analysis);
    }).catch(() => {});

    const socket = socketRef.current;
    if (!socket) return;

    socket.on('pipeline:steps', (data: { crashId: string; steps: PipelineStep[] }) => {
      if (data.crashId === id) setSteps(data.steps);
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
      socket.off('pipeline:complete');
      socket.off('pipeline:error');
    };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const isRunning = steps.some((s) => s.status === 'running');
  const isAwaitingAI = steps.some((s) => s.name === 'AI Analysis & Fix' && s.status === 'awaiting');

  const stopPipeline = async () => {
    if (!crash) return;
    try {
      await apiPost(`/pipeline/cancel/${crash.id}`, {});
    } catch (e: any) {
      console.error(e);
    }
  };

  const runPipeline = async () => {
    if (!crash) return;
    try {
      setHistory(null);
      setSteps([]);
      setAnalysis(null);
      // Carry releaseTag from history when crash record doesn't have it (e.g. after server restart)
      const payload = (!crash.releaseTag && history?.releaseTag)
        ? { ...crash, releaseTag: history.releaseTag }
        : crash;
      await apiPost(`/pipeline/run/${crash.id}`, payload);
    } catch (e: any) {
      console.error(e);
    }
  };

  const runAI = async () => {
    if (!crash) return;
    try {
      await apiPost(`/pipeline/run-ai/${crash.id}`, {});
    } catch (e: any) {
      console.error(e);
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
            <span>{crash.region || ''}</span>
            <span>{new Date(crash.receivedAt).toLocaleString('ko-KR')}</span>
          </div>
        </div>
        <div className="detail-actions">
          <StatusBadge status={crash.status} />
          {isRunning ? (
            <button className="btn btn-danger" onClick={stopPipeline}>
              <Square size={16} />
              Stop
            </button>
          ) : isAwaitingAI ? (
            <button className="btn btn-ai" onClick={runAI}>
              <Bot size={16} />
              Run by AI
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
          ) : crash.status === 'new' && (
            <button className="btn btn-primary" onClick={runPipeline}>
              <Play size={16} />
              Run Pipeline
            </button>
          )}
        </div>
      </div>

      <div className="detail-grid">
        {/* Pipeline Progress */}
        {steps.length > 0 && (
          <div className="detail-card">
            <h3>Pipeline Progress</h3>
            <PipelineView steps={steps} onRunAI={isAwaitingAI ? runAI : undefined} />
          </div>
        )}

        {/* Dump URL */}
        <div className="detail-card">
          <h3>Dump File</h3>
          <a href={crash.dumpUrl} target="_blank" rel="noreferrer" className="dump-link">
            <ExternalLink size={14} />
            {crash.dumpUrl}
          </a>
        </div>

        {/* Analysis Result */}
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
                    <pre className="diff-block">{file.diff}</pre>
                  </div>
                ))}
              </div>
            )}

            {analysis.prUrl && (
              <div className="detail-card pr-card">
                <h3>Pull Request</h3>
                <a href={analysis.prUrl} target="_blank" rel="noreferrer" className="pr-link">
                  <ExternalLink size={16} />
                  {analysis.prUrl}
                </a>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
