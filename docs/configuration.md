# 설정 가이드

CrashPilot은 웹 UI의 **Settings** 페이지에서 모든 설정을 관리합니다.
설정 값은 프로젝트 루트의 `config.json`에 저장됩니다.

---

## Crash Report Server

| 필드 | 설명 | 예시 |
|------|------|------|
| URL | 사내 크래시 리포트 서버 주소 | `http://192.168.1.100:8080` |
| Software IDs | 모니터링할 소프트웨어 ID (쉼표 구분) | `1, 2, 5` |

---

## Claude API

| 필드 | 설명 | 예시 |
|------|------|------|
| Model | 사용할 Claude 모델 ID | `claude-sonnet-4-6` |

> **인증**: Claude Code CLI의 인증을 사용합니다.
> 사전에 `claude` CLI로 로그인이 되어 있어야 합니다.
> ```bash
> claude auth login
> ```

---

## CDB Debugger

| 필드 | 설명 | 예시 |
|------|------|------|
| CDB Path | `cdb.exe` 전체 경로 | `C:\Program Files (x86)\Windows Kits\10\Debuggers\x64\cdb.exe` |

Windows SDK를 설치하면 CDB가 자동으로 포함됩니다.

---

## Git

| 필드 | 설명 | 예시 |
|------|------|------|
| Repository URL | GitHub 저장소 URL | `https://github.com/org/repo.git` |
| Clone Base Directory | 소스를 클론할 로컬 경로 | `D:\repos` |
| Branch Prefix | 릴리즈 브랜치 접두사 | `release/` |
| Default Branch | sw_version이 없을 때 fallback 브랜치 | `develop` |

### Tag → Branch Mapping

릴리즈 태그와 PR을 올릴 대상 브랜치를 수동으로 매핑합니다.

| 태그 | 브랜치 |
|------|--------|
| `pos/2.2.1/36` | `release/pos/2.2.1` |
| `touch/1.5.3/12` | `release/touch/1.5.3` |

매핑이 없는 경우 **자동 탐지**를 시도합니다.
- 태그의 첫 세그먼트(예: `pos`)를 SW 이름으로 추출
- GitHub API로 `release/` 하위 브랜치를 조회
- `release/{swName}/` 경로를 우선 탐색 (대소문자·구분자 차이 퍼지 매칭)
- 태그 커밋과 가장 가까운(ahead 수 최소) 브랜치를 base로 선택

자동 탐지도 실패할 경우에만 오류가 발생합니다. 그때 수동 매핑을 추가하세요.

---

## Release Build

덤프 분석에 필요한 PDB 파일을 가져오는 경로 설정입니다.

| 필드 | 설명 | 예시 |
|------|------|------|
| Release Build Base Dir | PDB 압축 해제 로컬 경로 | `D:\builds` |
| Build Network Base Dir | 빌드 ZIP이 있는 네트워크 경로 | `\\buildserver\builds` |
| Software Build Paths | 소프트웨어별 빌드 하위 경로 | `{"1": "pos/windows"}` |

ZIP 파일 경로는 아래 패턴으로 계산됩니다:
```
{buildNetworkBaseDir}/{softwareBuildPath}/{major.minor.patch}/Windows/Build/{version}_Release.zip
```
