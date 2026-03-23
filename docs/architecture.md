# 아키텍처

## 기술 스택

| 영역 | 기술 |
|------|------|
| 프론트엔드 | React 18, Vite, TypeScript |
| 백엔드 | Node.js, Express, TypeScript |
| 실시간 통신 | Socket.IO |
| AI 분석 | Claude Code CLI (`@anthropic-ai/claude-code`) |
| 덤프 분석 | CDB (Windows Debugger) |
| GitHub 연동 | Octokit REST |

---

## 디렉터리 구조

```
crashPilot/
├── client/                    # 프론트엔드 (React + Vite)
│   └── src/
│       ├── pages/
│       │   ├── Dashboard.tsx  # 크래시 목록, 태그 편집, 파이프라인 실행
│       │   ├── CrashDetail.tsx# 파이프라인 진행 상황 + 분석 결과
│       │   └── Settings.tsx   # 앱 설정
│       ├── components/
│       │   ├── PipelineView.tsx  # 단계별 파이프라인 UI
│       │   └── StatusBadge.tsx
│       ├── hooks/
│       │   ├── useSocket.ts   # Socket.IO 훅
│       │   └── useApi.ts      # REST API 헬퍼
│       └── types/index.ts     # 공유 타입 정의
│
├── server/                    # 백엔드 (Express)
│   └── src/
│       ├── index.ts           # 서버 진입점, Socket.IO 설정
│       ├── routes/
│       │   ├── crash.ts       # 크래시 리포트 CRUD + 인메모리 스토어
│       │   ├── pipeline.ts    # 파이프라인 실행/취소/재시도
│       │   ├── git.ts         # Git 레퍼런스 조회, Tag→Branch 매핑
│       │   └── config.ts      # 설정 읽기/저장
│       └── services/
│           ├── claude.ts      # Claude Code CLI 실행 & 응답 파싱
│           ├── crashReportServer.ts  # 사내 크래시 서버 API 클라이언트
│           ├── dump.ts        # PDB 다운로드, 덤프 다운로드, CDB 실행
│           ├── git.ts         # 브랜치 클론/체크아웃, 커밋/푸시
│           ├── github.ts      # GitHub PR 생성, 브랜치 탐색
│           └── config.ts      # config.json 읽기/쓰기
│
├── data/                      # 런타임 데이터 (gitignore)
│   ├── pipeline-runs/         # 파이프라인 실행 이력 (crashId.json)
│   └── tag-branch-map.json    # Tag → Branch 매핑 저장소
│
├── docs/                      # 문서
├── scripts/                   # 릴리즈 빌드 스크립트
├── launcher.bat               # Windows 실행 스크립트
├── launcher.sh                # macOS/Linux 실행 스크립트
└── config.json                # 앱 설정 (gitignore)
```

---

## 데이터 흐름

```
Browser (React)
    │  REST API + Socket.IO
    ▼
Express Server
    ├── /crash/*        → CrashReportServer API
    ├── /pipeline/run   → dump.ts → claude.ts → git.ts → github.ts
    ├── /git/*          → github.ts (브랜치 탐색)
    └── /config/*       → config.ts (설정 읽기/쓰기)
```

### 실시간 이벤트 (Socket.IO)

| 이벤트 | 방향 | 설명 |
|--------|------|------|
| `pipeline:steps` | Server → Client | 단계별 상태/로그 업데이트 |
| `pipeline:awaiting_ai` | Server → Client | AI 수동 확인 대기 |
| `pipeline:complete` | Server → Client | 파이프라인 완료 + 분석 결과 |
| `pipeline:error` | Server → Client | 파이프라인 에러 |
| `pipeline:cancelled` | Server → Client | 파이프라인 취소 |
| `crashes:updated` | Server → Client | 크래시 목록 갱신 |

---

## 파이프라인 상태 관리

파이프라인은 두 개의 독립된 HTTP 요청으로 분리됩니다.

1. **`POST /pipeline/run/:crashId`** — 단계 0~4 실행 후 `aiWaitStates`에 중간 상태 저장
2. **`POST /pipeline/run-ai/:crashId`** — 단계 5~9 실행 (저장된 상태 복원)

이 구조 덕분에 AI 분석 전에 사용자가 CDB 결과를 검토하고 커스텀 프롬프트를 입력할 수 있습니다.

실행 이력은 `data/pipeline-runs/{crashId}.json`에 저장되어 재시도 시 활용됩니다.

---

## GitHub 인증

별도의 API 키 없이 **로컬 git credential manager**를 사용합니다.

```
git credential fill (protocol=https, host=github.com)
```

일반적인 `git push`가 가능한 환경이면 PR 생성도 동작합니다.

---

## 서브모듈 PR 로직

```
fixedFiles 경로 분석
      │
      ├─ parent repo 파일 존재? → parent repo에 PR
      └─ submodule 파일 존재?  → 해당 submodule repo에 PR
```

변경 파일이 전부 서브모듈 안에 있으면 parent repo PR은 생성하지 않습니다.
(서브모듈 포인터 업데이트 PR 불필요)
