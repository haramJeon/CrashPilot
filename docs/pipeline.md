# 파이프라인 상세 설명

Dashboard에서 크래시 리포트의 **Run** 버튼을 클릭하면 파이프라인이 시작됩니다.

---

## 전체 흐름

```
[Dashboard] Run 클릭
      │
      ▼
① Load Stack Trace
② Prepare Work Dir (PDB 다운로드)
③ Download Dump (.dmp)
④ Analyze Dump (CDB)
      │
      ▼  ← 여기서 일시정지 (수동 확인)
⑤ Run by AI  ────────────────────────────────── 버튼 클릭
      │
      ▼
⑥ Clone / Pull
⑦ Init Submodule
⑧ AI Analysis & Fix
⑨ Apply Fix & Commit
⑩ Create PR
      │
      ▼
   완료 (PR URL 표시)
```

---

## 단계별 설명

### ① Load Stack Trace
크래시 리포트 서버 API에서 상세 정보를 조회합니다.
- 콜스택 프레임 수집
- 예외 코드 / bugcheck 코드 추출
- `releaseTag` 확인 (없으면 에러)

### ② Prepare Work Dir
크래시가 발생한 버전의 빌드 ZIP에서 PDB 파일을 추출합니다.
- 이미 추출된 경우 스킵
- 로컬 경로: `{releaseBuildBaseDir}/{appFolder}/{version}_Release/`

### ③ Download Dump
크래시 리포트에 포함된 URL에서 `.dmp` 파일을 다운로드합니다.
- 이미 다운로드된 경우 스킵

### ④ Analyze Dump (CDB)
CDB(Windows Debugger)로 덤프 파일을 분석합니다.
- 콜스택, 예외 타입, faulting module 추출
- 결과는 `{version}_cdb.txt`로 캐시됨
- CDB 실패 시 API에서 가져온 콜스택으로 대체 (경고 표시)

### ⑤ Run by AI (수동 게이트)
CDB 분석 결과를 확인한 후 AI 분석을 수동으로 시작합니다.

**커스텀 프롬프트**: AI에게 추가 지시사항을 입력할 수 있습니다.
예) `"memory leak 관점에서 분석해줘"`, `"foo.cpp 파일을 중점적으로 봐줘"`

### ⑥ Clone / Pull
릴리즈 브랜치 소스코드를 로컬에 클론합니다.
- 이미 클론된 경우 스킵
- 경로: `{repoBaseDir}/{branch이름을_슬래시_대체}/`

### ⑦ Init Submodule
저장소에 `.gitmodules`가 있으면 서브모듈을 초기화합니다.
- 이미 초기화된 경우 스킵

### ⑧ AI Analysis & Fix
Claude Code CLI가 CDB 분석 결과를 바탕으로 소스코드를 수정합니다.
- CDB txt 파일을 직접 읽고 크래시 원인 파악
- 저장소에서 관련 소스 파일 탐색
- 최소한의 수정만 적용
- 결과: `rootCause`, `suggestedFix`, `fixedFiles` (한글 응답)

### ⑨ Apply Fix & Commit
수정된 파일을 디스크에 기록하고 fix 브랜치에 커밋 & 푸시합니다.
- fix 브랜치명: `crashpilot/{crashId}-{timestamp}`
- 커밋 메시지에 예외 타입, 모듈명, 버전 정보 포함

### ⑩ Create PR
GitHub API로 Pull Request를 생성합니다.
- **서브모듈 지원**: 변경 파일이 서브모듈 안에 있으면 해당 서브모듈 저장소에만 PR 생성
- 변경 파일이 parent repo에도 있을 경우 parent repo에도 PR 생성
- Tag → Branch 매핑으로 PR base 브랜치 결정

---

## 재시도 (Retry)

파이프라인 실패 시 특정 단계부터 재시도할 수 있습니다.

| 재시도 시작 단계 | 동작 |
|----------------|------|
| 0~4 | 처음부터 재실행 |
| 5~8 | 저장된 상태(PDB 경로, CDB 결과)에서 AI 단계부터 재개 |
| 9 (PR만) | 커밋은 그대로 두고 PR 생성만 재시도 |

---

## 취소 (Cancel)

파이프라인 실행 중 **Cancel** 버튼으로 언제든 중단할 수 있습니다.
AI 분석 대기 중(`⑤ Run by AI`)에도 Cancel 가능합니다.
