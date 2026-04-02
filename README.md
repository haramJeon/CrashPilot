# CrashPilot

**CrashPilot**는 C++ 애플리케이션의 크래시 리포트를 자동으로 분석하고, AI가 수정 코드를 생성해 GitHub Pull Request까지 자동으로 만들어주는 도구입니다.

## 주요 기능

- 사내 크래시 리포트 서버에서 `.dmp` 덤프 파일 자동 다운로드
- CDB (Windows Debugger) 를 이용한 콜스택 분석
- **Claude AI** 가 크래시 원인 파악 및 소스코드 자동 수정
- 수정 브랜치 생성 → 커밋 & 푸시 → GitHub PR 자동 생성
- 서브모듈 구조 지원 (변경된 파일이 속한 서브모듈에만 PR 생성)

## 스크린샷

| Dashboard | Pipeline |
|-----------|----------|
| 크래시 목록 및 태그 관리 | 단계별 파이프라인 진행 상황 |
|![bandicam 2026-03-20 17-49-00-089](https://github.com/user-attachments/assets/1b0dd781-8a58-49ee-bbbb-af6748b5d51a)| ![bandicam 2026-03-20 17-49-04-277](https://github.com/user-attachments/assets/17e468e6-9627-470e-b592-9b785a284d0f)



---

## 시작하기

### 필수 요구사항

| 항목 | 비고 |
|------|------|
| [Node.js](https://nodejs.org) 18 이상 | 서버 & 클라이언트 실행 |
| [Claude Code CLI](https://github.com/anthropics/claude-code) | `npm install -g @anthropic-ai/claude-code` (없으면 자동 설치) |
| CDB (Windows Debugger) | Windows SDK 설치 시 포함 |
| GitHub 계정 | git credential manager로 인증 |

### 설치 및 실행


**Windows**

```
crashpilot-server.exe 더블 클릭 (http://localhost:3001 브라우저 자동 실행)
```

의존성 설치 → 클라이언트 빌드 → 서버 시작이 자동으로 진행됩니다.

**macOS / Linux**

```bash
not implemented.
```

**개발 모드**

```bash
npm install
npm run dev
브라우저에서 `http://localhost:5173` 접속
```


---

## 설정

최초 실행 후 **Settings** 페이지에서 아래 항목을 설정합니다.

| 항목 | 설명 |
|------|------|
| Crash Report Server URL | 사내 크래시 리포트 서버 주소 |
| Software IDs | 모니터링할 소프트웨어 ID 목록 |
| Claude Model | 사용할 Claude 모델 (기본: `claude-sonnet-4-6`) |
| Git Repository URL | 소스코드 GitHub 저장소 URL |
| Git Clone Base Directory | 로컬에서 소스를 클론할 루트 경로 |
| Release Build Base Directory | PDB 파일을 추출할 로컬 경로 |
| Build Network Base Directory | 빌드 ZIP 파일이 있는 네트워크 경로 |
| Tag → Branch Mapping | 릴리즈 태그와 PR 대상 브랜치 매핑 |

자세한 내용은 [docs/configuration.md](docs/configuration.md)를 참고하세요.

---

## 파이프라인

크래시 리포트를 선택하고 **Run** 버튼을 누르면 아래 단계가 순서대로 실행됩니다.

```
① Load Stack Trace   — 크래시 리포트 서버에서 콜스택 로드
② Prepare Work Dir  — PDB 파일 다운로드 & 압축 해제
③ Download Dump     — .dmp 파일 다운로드
④ Analyze Dump (CDB)— CDB로 덤프 분석 (콜스택, 예외, 레지스터)
⑤ Fix by AI         — [수동 확인] AI 분석 시작 버튼
⑥ Clone / Pull      — 릴리즈 브랜치 클론 또는 갱신
⑦ Init Submodule    — git submodule update --init
⑧ AI Analysis & Fix — Claude가 원인 분석 및 소스 수정
⑨ Apply Fix & Commit— 수정 파일 커밋 & 원격 푸시
⑩ Create PR         — GitHub Pull Request 자동 생성
```

⑤번 단계에서 CDB 분석 결과를 확인한 후 수동으로 AI 분석을 시작합니다.
커스텀 프롬프트를 입력해 AI에게 추가 지시를 줄 수 있습니다.

자세한 내용은 [docs/pipeline.md](docs/pipeline.md)를 참고하세요.

---

## 아키텍처

```
crashPilot/
├── client/          # React + Vite + TypeScript (프론트엔드)
├── server/          # Node.js + Express + TypeScript (백엔드)
│   └── src/
│       ├── routes/  # REST API 라우터
│       └── services/# 핵심 비즈니스 로직
├── launcher.bat     # Windows 실행 스크립트
├── launcher.sh      # macOS/Linux 실행 스크립트
└── scripts/         # 릴리즈 빌드 스크립트
```

자세한 내용은 [docs/architecture.md](docs/architecture.md)를 참고하세요.

---

## 라이선스

Private — 사내 전용 도구입니다.
