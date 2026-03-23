# CrashPilot — Frontend

React + Vite + TypeScript 기반의 CrashPilot 웹 UI입니다.

## 페이지 구성

| 페이지 | 경로 | 설명 |
|--------|------|------|
| Dashboard | `/` | 크래시 리포트 목록 조회, releaseTag 설정, 파이프라인 실행 |
| CrashDetail | `/crash/:id` | 파이프라인 단계별 진행 상황, CDB 결과, AI 분석 결과, PR URL |
| Settings | `/settings` | config.json 편집 (서버 URL, Claude 모델, CDB 경로, Git 설정 등) |

## 개발 실행

```bash
npm install
npm run dev   # http://localhost:5173 (백엔드 proxy: localhost:3001)
```

## 빌드

```bash
npm run build   # dist/ 생성 → 백엔드가 정적 파일로 서빙
```

## 주요 구조

```
src/
├── pages/
│   ├── Dashboard.tsx     # 크래시 목록 + 파이프라인 시작
│   ├── CrashDetail.tsx   # 파이프라인 상세 + 재시도
│   └── Settings.tsx      # 설정 편집
├── components/
│   ├── PipelineView.tsx  # 10단계 파이프라인 UI (로그 토글, retry 버튼)
│   └── StatusBadge.tsx   # 상태 뱃지
├── hooks/
│   ├── useApi.ts         # fetch 래퍼 (apiGet / apiPost / apiPatch)
│   └── useSocket.ts      # Socket.IO 연결 훅
└── types/index.ts        # 공유 타입 정의
```
