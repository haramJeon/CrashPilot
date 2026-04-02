import { useState, useEffect } from 'react';
import { Download, X, ArrowUp } from 'lucide-react';
import { apiGet } from '../hooks/useApi';
import './UpdateNotification.css';

interface UpdateCheckResult {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion: string;
  downloadUrl?: string;
  releaseUrl?: string;
  releaseNotes?: string;
  error?: string;
}

export default function UpdateNotification() {
  const [info, setInfo] = useState<UpdateCheckResult | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [showNotes, setShowNotes] = useState(false);

  useEffect(() => {
    apiGet<UpdateCheckResult>('/update/check')
      .then((res) => setInfo(res))
      .catch(() => {});
  }, []);

  if (!info?.hasUpdate || dismissed) return null;

  const installUrl = info.downloadUrl ?? info.releaseUrl;

  return (
    <div className="update-modal-backdrop">
      <div className="update-modal">
        {/* Header */}
        <div className="update-modal-header">
          <div className="update-modal-header-icon">
            <ArrowUp size={20} />
          </div>
          <h3 className="update-modal-title">새 업데이트가 있습니다</h3>
          <button className="update-modal-close" onClick={() => setDismissed(true)} title="닫기">
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="update-modal-body">
          <p className="update-modal-msg">
            최신 버전 <strong>v{info.latestVersion}</strong>이 출시되었습니다.<br />
            현재 버전: v{info.currentVersion}
          </p>
          <p className="update-modal-ask">
            다운로드 후 기존 프로그램을 종료하고 새 버전을 실행하세요.
          </p>
          {info.releaseNotes && (
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
        </div>

        {/* Footer */}
        <div className="update-modal-footer">
          <button className="update-btn update-btn-secondary" onClick={() => setDismissed(true)}>
            나중에
          </button>
          {installUrl ? (
            <a className="update-btn update-btn-primary" href={installUrl} download>
              <Download size={14} />
              다운로드
            </a>
          ) : (
            <button className="update-btn update-btn-primary" disabled>
              <Download size={14} />
              다운로드
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
