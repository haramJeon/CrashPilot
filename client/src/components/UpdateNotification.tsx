import { useState, useEffect } from 'react';
import { Download, RefreshCw, X, ArrowUp, Loader2, CheckCircle, AlertTriangle } from 'lucide-react';
import { apiGet, apiPost } from '../hooks/useApi';
import { useSocket } from '../hooks/useSocket';
import './UpdateNotification.css';

interface UpdateCheckResult {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion: string;
  updateState: string;
  releaseNotes?: string;
  error?: string;
}

type UpdateState = 'idle' | 'downloading' | 'staging' | 'ready' | 'applying' | 'error';

export default function UpdateNotification() {
  const [info, setInfo] = useState<UpdateCheckResult | null>(null);
  const [state, setState] = useState<UpdateState>('idle');
  const [stateMessage, setStateMessage] = useState('');
  const [progress, setProgress] = useState<{ percent: number; bytesDownloaded: number; totalBytes: number } | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [showNotes, setShowNotes] = useState(false);
  const socketRef = useSocket();

  // Check for updates on mount
  useEffect(() => {
    apiGet<UpdateCheckResult>('/update/check')
      .then((res) => {
        setInfo(res);
        if (res.updateState) setState(res.updateState as UpdateState);
      })
      .catch(() => {}); // silently ignore
  }, []);

  // Socket events
  useEffect(() => {
    const socket = socketRef.current;
    if (!socket) return;

    const onState = ({ state: s, message, latestVersion }: any) => {
      setState(s);
      setStateMessage(message ?? '');
      if (s === 'ready' && latestVersion) {
        setInfo((prev) => prev ? { ...prev, latestVersion } : prev);
      }
      if (s === 'idle' || s === 'ready') setProgress(null);
    };

    const onProgress = (data: any) => {
      setProgress({ percent: data.percent, bytesDownloaded: data.bytesDownloaded, totalBytes: data.totalBytes });
    };

    socket.on('update:state', onState);
    socket.on('update:progress', onProgress);

    return () => {
      socket.off('update:state', onState);
      socket.off('update:progress', onProgress);
    };
  }, [socketRef]);

  const startDownload = async () => {
    setDismissed(false);
    try {
      await apiPost('/update/download', {});
    } catch (e: any) {
      setState('error');
      setStateMessage(e.message);
    }
  };

  const applyUpdate = async () => {
    try {
      await apiPost('/update/apply', {});
      setState('applying');
      setStateMessage('재시작 중... 잠시 후 자동으로 새로고침됩니다.');
      // Poll until server comes back up
      setTimeout(() => pollForRestart(), 5000);
    } catch (e: any) {
      setState('error');
      setStateMessage(e.message);
    }
  };

  const pollForRestart = () => {
    apiGet('/update/check')
      .then(() => window.location.reload())
      .catch(() => setTimeout(() => pollForRestart(), 2000));
  };

  const formatBytes = (bytes: number) => {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  // Nothing to show
  if (!info?.hasUpdate && state === 'idle') return null;
  if (dismissed && state === 'idle') return null;

  // Applying state: full-screen overlay
  if (state === 'applying') {
    return (
      <div className="update-overlay">
        <Loader2 size={40} className="update-overlay-spin" />
        <p>업데이트 적용 중...</p>
        <p className="update-overlay-sub">잠시 후 자동으로 재시작됩니다</p>
      </div>
    );
  }

  return (
    <div className={`update-banner update-banner-${state}`}>
      <div className="update-banner-content">
        <div className="update-banner-left">
          {state === 'idle' && <ArrowUp size={16} className="update-icon" />}
          {(state === 'downloading' || state === 'staging') && <Loader2 size={16} className="update-icon spin" />}
          {state === 'ready' && <CheckCircle size={16} className="update-icon" />}
          {state === 'error' && <AlertTriangle size={16} className="update-icon" />}

          <div className="update-banner-text">
            {state === 'idle' && (
              <>
                <strong>새 버전 사용 가능:</strong> v{info?.latestVersion}
                {info?.releaseNotes && (
                  <button className="update-notes-toggle" onClick={() => setShowNotes((v) => !v)}>
                    {showNotes ? '숨기기' : '릴리즈 노트'}
                  </button>
                )}
              </>
            )}
            {state === 'downloading' && (
              <>
                <strong>다운로드 중...</strong>
                {progress && (
                  <span className="update-progress-text">
                    {progress.totalBytes > 0
                      ? `${formatBytes(progress.bytesDownloaded)} / ${formatBytes(progress.totalBytes)} (${progress.percent}%)`
                      : formatBytes(progress.bytesDownloaded)}
                  </span>
                )}
              </>
            )}
            {state === 'staging' && <strong>업데이트 파일 준비 중...</strong>}
            {state === 'ready' && (
              <strong>v{info?.latestVersion} 다운로드 완료 — 재시작하면 업데이트가 적용됩니다</strong>
            )}
            {state === 'error' && (
              <>
                <strong>업데이트 실패:</strong> <span className="update-error-msg">{stateMessage}</span>
              </>
            )}
          </div>
        </div>

        <div className="update-banner-actions">
          {state === 'idle' && (
            <button className="update-btn update-btn-primary" onClick={startDownload}>
              <Download size={14} />
              다운로드 & 설치
            </button>
          )}
          {state === 'ready' && (
            <button className="update-btn update-btn-restart" onClick={applyUpdate}>
              <RefreshCw size={14} />
              지금 재시작
            </button>
          )}
          {state === 'error' && (
            <button className="update-btn update-btn-primary" onClick={startDownload}>
              <RefreshCw size={14} />
              재시도
            </button>
          )}
          {(state === 'idle' || state === 'error') && (
            <button className="update-dismiss" onClick={() => setDismissed(true)} title="닫기">
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      {(state === 'downloading') && progress && progress.totalBytes > 0 && (
        <div className="update-progress-bar">
          <div className="update-progress-fill" style={{ width: `${progress.percent}%` }} />
        </div>
      )}

      {showNotes && info?.releaseNotes && (
        <div className="update-release-notes">
          <pre>{info.releaseNotes}</pre>
        </div>
      )}
    </div>
  );
}
