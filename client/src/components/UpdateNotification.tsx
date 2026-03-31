import { useState, useEffect } from 'react';
import { Download, RefreshCw, X, Loader2, CheckCircle, AlertTriangle, ArrowUp } from 'lucide-react';
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
    <div className="update-modal-backdrop">
      <div className="update-modal">
        {/* Header */}
        <div className="update-modal-header">
          <div className="update-modal-header-icon">
            {state === 'idle' && <ArrowUp size={20} />}
            {(state === 'downloading' || state === 'staging') && <Loader2 size={20} className="spin" />}
            {state === 'ready' && <CheckCircle size={20} />}
            {state === 'error' && <AlertTriangle size={20} />}
          </div>
          <h3 className="update-modal-title">
            {state === 'idle' && '새 업데이트가 있습니다'}
            {state === 'downloading' && '업데이트 다운로드 중'}
            {state === 'staging' && '업데이트 준비 중'}
            {state === 'ready' && '업데이트 준비 완료'}
            {state === 'error' && '업데이트 오류'}
          </h3>
          {(state === 'idle' || state === 'error') && (
            <button className="update-modal-close" onClick={() => setDismissed(true)} title="닫기">
              <X size={16} />
            </button>
          )}
        </div>

        {/* Body */}
        <div className="update-modal-body">
          {state === 'idle' && (
            <>
              <p className="update-modal-msg">
                최신 버전 <strong>v{info?.latestVersion}</strong>이 출시되었습니다.<br />
                현재 버전: v{info?.currentVersion}
              </p>
              <p className="update-modal-ask">지금 다운로드하여 설치하시겠습니까?</p>
              {info?.releaseNotes && (
                <>
                  <button className="update-notes-toggle" onClick={() => setShowNotes((v) => !v)}>
                    {showNotes ? '릴리즈 노트 숨기기' : '릴리즈 노트 보기'}
                  </button>
                  {showNotes && (
                    <div className="update-release-notes">
                      <pre>{info.releaseNotes}</pre>
                    </div>
                  )}
                </>
              )}
            </>
          )}

          {state === 'downloading' && (
            <>
              <p className="update-modal-msg">
                v{info?.latestVersion} 다운로드 중...
              </p>
              {progress && progress.totalBytes > 0 && (
                <div className="update-progress-bar">
                  <div className="update-progress-fill" style={{ width: `${progress.percent}%` }} />
                </div>
              )}
              {progress && (
                <p className="update-progress-text">
                  {progress.totalBytes > 0
                    ? `${formatBytes(progress.bytesDownloaded)} / ${formatBytes(progress.totalBytes)} (${progress.percent}%)`
                    : formatBytes(progress.bytesDownloaded)}
                </p>
              )}
            </>
          )}

          {state === 'staging' && (
            <p className="update-modal-msg">업데이트 파일을 준비하고 있습니다...</p>
          )}

          {state === 'ready' && (
            <p className="update-modal-msg">
              <strong>v{info?.latestVersion}</strong> 설치 준비가 완료되었습니다.<br />
              재시작하면 업데이트가 적용됩니다.
            </p>
          )}

          {state === 'error' && (
            <p className="update-modal-msg update-error-msg">
              {stateMessage}
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="update-modal-footer">
          {state === 'idle' && (
            <>
              <button className="update-btn update-btn-secondary" onClick={() => setDismissed(true)}>
                나중에
              </button>
              <button className="update-btn update-btn-primary" onClick={startDownload}>
                <Download size={14} />
                설치
              </button>
            </>
          )}

          {(state === 'downloading' || state === 'staging') && (
            <p className="update-modal-status">잠시만 기다려 주세요...</p>
          )}

          {state === 'ready' && (
            <button className="update-btn update-btn-restart" onClick={applyUpdate}>
              <RefreshCw size={14} />
              지금 재시작
            </button>
          )}

          {state === 'error' && (
            <>
              <button className="update-btn update-btn-secondary" onClick={() => setDismissed(true)}>
                닫기
              </button>
              <button className="update-btn update-btn-primary" onClick={startDownload}>
                <RefreshCw size={14} />
                재시도
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
