/**
 * Crash 분류 서비스
 *
 * 분류 로직:
 * 1. 각 crash의 스택 지문(fingerprint) 추출
 * 2. 동일 지문끼리 그루핑
 * 3. 그룹별 Claude 판정:
 *    - issueKey 있음 → Jira 이슈와 매칭 검증 (validated / misclassified)
 *    - issueKey 없음 → 기존 이슈 검색 (assign / new_issue)
 *
 * ⚠️  Jira write 작업(이슈 생성/수정)은 절대 자동으로 하지 않음
 */
import { CrashReport, ClassificationResult, ClassificationVerdict, AppConfig } from '../types';
import { fetchJiraIssue, fetchOpenIssues, isJiraConfigured } from './jira';
import { runClaude } from './claude';
import { fetchReportDetail, fetchReports } from './crashReportServer';

// ─────────────────────────────────────────────────────────────────────────
// Fingerprint
// ─────────────────────────────────────────────────────────────────────────

const SYSTEM_DLLS = new Set([
  'ntdll', 'kernel32', 'kernelbase', 'msvcrt', 'ucrtbase', 'msvcp140',
  'vcruntime140', 'user32', 'gdi32', 'combase', 'ole32', 'rpcrt4',
  'sechost', 'advapi32', 'ws2_32', 'shlwapi', 'shell32', 'clr', 'mscorwks',
]);

// 자체 DLL이더라도 스택에 이 함수들만 있으면 특정 이슈와 연결할 수 없는 범용 크래시
const GENERIC_FUNCTIONS = new Set([
  'abort', '_abort', '__abort', 'terminate', '_invoke_watson',
  'raise', '_raise', 'signal', '_signal', 'exit', '_exit',
  'raisefailfast', 'raisefastfailexception', 'raiseexception',
  'unhandledexceptionfilter', 'kiuserexceptiondispatcher',
  '_call_terminate', '__crtterminateprocess', '__fastfail',
  'debugbreak', 'fatalappexit',
]);

function isSystemFrame(dllName: string): boolean {
  const name = dllName.toLowerCase().replace(/\.dll$/, '').split('!')[0];
  return SYSTEM_DLLS.has(name);
}

/**
 * 스택이 범용적(generic)인지 판단.
 * 조건: 자체 코드 프레임이 하나도 없거나,
 *       자체 코드 프레임이 있어도 전부 GENERIC_FUNCTIONS에 해당하는 경우.
 */
export function isGenericStack(crash: CrashReport): boolean {
  const frames = crash.stackTraces.length > 0 ? crash.stackTraces : crash.mainStackTraces;
  if (frames.length === 0) return false; // 스택 자체 없음은 no_stack으로 처리

  const ownFrames = frames.filter((f) => !isSystemFrame(f.dllName));
  if (ownFrames.length === 0) return true; // 자체 프레임 전무 → 범용

  // 자체 프레임이 있어도 전부 범용 함수면 범용 스택
  return ownFrames.every((f) => {
    const fn = (f.functionName ?? '').toLowerCase().replace(/[^a-z_]/g, '');
    return !fn || GENERIC_FUNCTIONS.has(fn);
  });
}

/**
 * 스택 지문 추출: stackTraces에서 자체 코드 프레임 상위 5개
 * 없으면 mainStackTraces에서 추출
 */
export function extractFingerprint(crash: CrashReport): string {
  const frames = crash.stackTraces.length > 0 ? crash.stackTraces : crash.mainStackTraces;
  const ownFrames = frames
    .filter((f) => !isSystemFrame(f.dllName))
    .slice(0, 5);

  if (ownFrames.length === 0) {
    // 자체 프레임이 없으면 전체 상위 3개
    return frames
      .slice(0, 3)
      .map((f) => (f.functionName ? `${f.dllName}!${f.functionName}` : f.dllName))
      .join(' | ');
  }

  return ownFrames
    .map((f) => (f.functionName ? `${f.dllName}!${f.functionName}` : f.dllName))
    .join(' | ');
}

// ─────────────────────────────────────────────────────────────────────────
// Claude 판정
// ─────────────────────────────────────────────────────────────────────────

interface ClaudeVerdict {
  verdict: ClassificationVerdict;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  suggestedIssueKey?: string;
  suggestedIssueSummary?: string;
}

async function askClaude(
  prompt: string,
  onLog?: (line: string) => void,
  shouldAbort?: () => boolean,
  model?: string,
): Promise<string> {
  const { promise } = runClaude(prompt, undefined, [], onLog, shouldAbort, model);
  return promise;
}

function parseClaudeJson(raw: string): any {
  // JSON 블록 추출 (```json ... ``` 또는 { ... } 직접)
  const jsonMatch = raw.match(/```json\s*([\s\S]*?)```/) || raw.match(/(\{[\s\S]*\})/);
  if (jsonMatch) {
    return JSON.parse(jsonMatch[1]);
  }
  return JSON.parse(raw.trim());
}

/** issueKey가 있는 그룹: Jira 이슈와 스택 매칭 검증 */
async function validateMapping(
  crash: CrashReport,
  fingerprint: string,
  openIssues: Array<{ key: string; summary: string; description?: string }>,
  config: AppConfig,
  onLog?: (line: string) => void,
  shouldAbort?: () => boolean,
  strict?: boolean,
): Promise<ClaudeVerdict> {
  const issueKey = crash.issueKey!;

  let issueSummary = issueKey;
  let issueDescription = '';
  try {
    const jiraIssue = await fetchJiraIssue(config, issueKey);
    issueSummary = jiraIssue.summary;
    issueDescription = jiraIssue.description ?? '';
  } catch (e) {
    onLog?.(`[classifier] Jira 이슈 조회 실패 ${issueKey}: ${e}`);
  }

  // 전체 스택 프레임 (fingerprint는 상위 5개만이므로 전체도 함께 제공)
  const allFrames = crash.stackTraces.length > 0 ? crash.stackTraces : crash.mainStackTraces;
  const fullStack = allFrames.length > 0
    ? allFrames
        .slice(0, 30)
        .map((f, i) => `  #${i} ${f.functionName ? `${f.dllName}!${f.functionName}` : f.dllName}`)
        .join('\n')
    : '(스택 없음)';

  // 현재 이슈를 제외한 열린 이슈 목록 (misclassified 시 대안 추천용)
  const otherIssues = openIssues.filter((i) => i.key !== issueKey);
  const issueListText = otherIssues.length > 0
    ? otherIssues
        .map((i) => `- ${i.key}: ${i.summary}${i.description ? ` | ${i.description.slice(0, 100)}` : ''}`)
        .join('\n')
    : '(없음)';

  const prompt = `당신은 C++ 크래시 리포트와 Jira 이슈의 매핑이 올바른지 검증하는 전문가입니다.

## 크래시 정보
- Subject: ${crash.subject}
- Exception Code: ${crash.exceptionCode ?? 'unknown'}
- SW Version: ${crash.swVersion}
- Stack Fingerprint (핵심 프레임):
  ${fingerprint || '(없음)'}
- Full Stack (상위 30프레임):
${fullStack}

## 현재 매핑된 Jira 이슈
- Key: ${issueKey}
- Summary: ${issueSummary}
${issueDescription ? `- Description: ${issueDescription}` : ''}

## 판단 기준
${strict
  ? `- OS 타입 차이(Windows/macOS)는 판단 근거로 사용하지 않는다
- 스택의 핵심 함수명과 DLL명이 Jira 이슈의 내용(Summary/Description)과 논리적으로 관련 있으면 validated
- 전혀 다른 기능/모듈의 크래시라면 misclassified
- 스택이 ntdll·kernel32 등 시스템 DLL만으로 구성되거나, 크래시 위치가 범용 런타임 함수(예: abort, terminate, RaiseException)뿐이어서 특정 이슈와 논리적으로 연결할 수 없으면 needs_analysis
- 확신하기 어려우면 confidence를 low로`
  : `- SW 버전 차이는 판단 근거로 사용하지 않는다
- 스택(Full Stack 포함) 어디에든 Jira 이슈 Summary/Description에 언급된 함수명·모듈명이 등장하면 validated
- 크래시 위치(발생 함수·모듈)가 Jira 이슈와 같거나 인접한 call stack 흐름이면 validated
- 스택에 공통 함수/모듈이 전혀 없고 완전히 다른 기능 영역임이 명확할 때만 misclassified
- 스택 정보가 부족하거나 비교가 불확실한 경우 needs_analysis`
}

## 대안 이슈 목록 (misclassified 판정 시 아래 목록에서 가장 적합한 이슈를 추천)
${issueListText}

## 출력 형식 (JSON만, 마크다운 없이)
{
  "verdict": "validated" 또는 "misclassified" 또는 "needs_analysis",
  "confidence": "high" 또는 "medium" 또는 "low",
  "reason": "판단 이유 (한국어, 2-3문장)",
  "suggestedIssueKey": "misclassified일 때만 — 대안 이슈 목록 중 가장 적합한 이슈 키 (없으면 생략)",
  "suggestedIssueSummary": "suggestedIssueKey가 있을 때 해당 이슈 요약"
}`;

  try {
    const raw = await askClaude(prompt, onLog, shouldAbort, config.claude.model);
    const parsed = parseClaudeJson(raw);
    return {
      verdict: parsed.verdict ?? 'needs_analysis',
      confidence: parsed.confidence ?? 'low',
      reason: parsed.reason ?? '',
      suggestedIssueKey: parsed.suggestedIssueKey,
      suggestedIssueSummary: parsed.suggestedIssueSummary,
    };
  } catch (e) {
    return { verdict: 'needs_analysis', confidence: 'low', reason: `분석 실패: ${e}` };
  }
}

/** issueKey가 없는 그룹: 기존 이슈 목록과 비교 */
async function classifyUnmapped(
  crash: CrashReport,
  fingerprint: string,
  openIssues: Array<{ key: string; summary: string; description?: string }>,
  config: AppConfig,
  onLog?: (line: string) => void,
  shouldAbort?: () => boolean,
): Promise<ClaudeVerdict> {
  const issueListText = openIssues.length > 0
    ? openIssues
        .map((i) => `- ${i.key}: ${i.summary}${i.description ? ` | ${i.description.slice(0, 100)}` : ''}`)
        .join('\n')
    : '(열린 이슈 없음)';

  const allFrames = crash.stackTraces.length > 0 ? crash.stackTraces : crash.mainStackTraces;
  const fullStack = allFrames.length > 0
    ? allFrames
        .slice(0, 30)
        .map((f, i) => `  #${i} ${f.functionName ? `${f.dllName}!${f.functionName}` : f.dllName}`)
        .join('\n')
    : '(스택 없음)';

  const prompt = `당신은 C++ 크래시 리포트를 기존 Jira 이슈에 분류하는 전문가입니다.

## 크래시 정보
- Subject: ${crash.subject}
- Exception Code: ${crash.exceptionCode ?? 'unknown'}
- SW Version: ${crash.swVersion}
- Stack Fingerprint (핵심 프레임):
  ${fingerprint || '(없음)'}
- Full Stack (상위 30프레임):
${fullStack}

## 기존 열린 Jira 이슈 목록
${issueListText}

## 판단 기준
- Full Stack(fingerprint 포함) 어디에든 기존 이슈 Summary/Description에 언급된 함수명·모듈명이 등장하면 assign
- 크래시 발생 위치(함수·모듈)가 기존 이슈와 같거나 인접한 call stack 흐름이면 assign
- 어느 이슈와도 관련 없는 새로운 유형의 크래시 → new_issue

## 출력 형식 (JSON만, 마크다운 없이)
{
  "verdict": "assign" 또는 "new_issue",
  "confidence": "high" 또는 "medium" 또는 "low",
  "reason": "판단 이유 (한국어, 2-3문장)",
  "suggestedIssueKey": "assign일 때 매칭된 이슈 키 (예: APOS-123)",
  "suggestedIssueSummary": "매칭된 이슈 요약"
}`;

  try {
    const raw = await askClaude(prompt, onLog, shouldAbort, config.claude.model);
    const parsed = parseClaudeJson(raw);
    return {
      verdict: parsed.verdict ?? 'new_issue',
      confidence: parsed.confidence ?? 'low',
      reason: parsed.reason ?? '',
      suggestedIssueKey: parsed.suggestedIssueKey,
      suggestedIssueSummary: parsed.suggestedIssueSummary,
    };
  } catch (e) {
    return { verdict: 'new_issue', confidence: 'low', reason: `분석 실패: ${e}` };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Project key auto-detection
// ─────────────────────────────────────────────────────────────────────────

/** crash의 issueKey 목록에서 Jira 프로젝트 키를 자동 추출 (예: "APOS-2486" → "APOS") */
export function detectProjectKeys(crashes: CrashReport[]): string[] {
  const keys = new Set<string>();
  for (const crash of crashes) {
    if (crash.issueKey && crash.issueKey !== 'None') {
      const match = crash.issueKey.match(/^([A-Z][A-Z0-9]+)-\d+$/);
      if (match) keys.add(match[1]);
    }
  }
  return Array.from(keys);
}

// ─────────────────────────────────────────────────────────────────────────
// Main classification entry point
// ─────────────────────────────────────────────────────────────────────────

export interface ClassifyProgress {
  current: number;
  total: number;
  message: string;
}

/** 현재 배치에서 project key를 못 찾으면 해당 소프트웨어의 최신 리포트에서 fallback 탐색 */
async function detectProjectKeysWithFallback(
  crashes: CrashReport[],
  softwareId: number | undefined,
  onLog?: (line: string) => void,
): Promise<string[]> {
  const keys = detectProjectKeys(crashes);
  if (keys.length > 0) return keys;
  if (!softwareId) return [];

  onLog?.('[classifier] 현재 배치에 issueKey 없음 — 동일 소프트웨어 최신 리포트에서 project key 탐색 중...');
  try {
    // 최신 페이지 1개만 조회 (최대 20건 정도)
    const historical = await fetchReports(softwareId, {}, 1);
    const fallbackKeys = detectProjectKeys(historical);
    if (fallbackKeys.length > 0) {
      onLog?.(`[classifier] fallback project key 감지: ${fallbackKeys.join(', ')}`);
    } else {
      onLog?.('[classifier] fallback에서도 issueKey 없음 — 전체 프로젝트에서 이슈 검색');
    }
    return fallbackKeys;
  } catch (e) {
    onLog?.(`[classifier] fallback 조회 실패: ${e}`);
    return [];
  }
}

export async function classifyCrashes(
  crashes: CrashReport[],
  config: AppConfig,
  onProgress?: (p: ClassifyProgress) => void,
  onLog?: (line: string) => void,
  shouldAbort?: () => boolean,
  softwareId?: number,
  strict?: boolean,
  sprintId?: number | null,
): Promise<ClassificationResult[]> {
  const results: ClassificationResult[] = [];
  const total = crashes.length;

  // Step 1: 스택 정보 없는 crash는 detail 조회 (최대 5개 동시)
  onProgress?.({ current: 0, total, message: '스택 정보 로딩 중...' });
  const enriched = await enrichWithDetails(crashes, onLog, shouldAbort);

  // Step 2: crash의 issueKey에서 프로젝트 키 자동 추출 후 열린 이슈 목록 조회
  let openIssues: Array<{ key: string; summary: string; description?: string }> = [];
  if (isJiraConfigured(config)) {
    try {
      if (sprintId) {
        onLog?.(`[classifier] 스프린트 ID ${sprintId} 기준으로 이슈 조회 중...`);
      }
      const projectKeys = await detectProjectKeysWithFallback(enriched, softwareId, onLog);
      if (!sprintId && projectKeys.length > 0) {
        onLog?.(`[classifier] 프로젝트 키 자동 감지: ${projectKeys.join(', ')}`);
      }
      openIssues = await fetchOpenIssues(config, projectKeys, sprintId);
      onLog?.(`[classifier] 열린 이슈 ${openIssues.length}개 로드 완료`);
    } catch (e) {
      onLog?.(`[classifier] Jira 이슈 목록 조회 실패: ${e}`);
    }
  }

  // Step 3: 각 crash 분류 (순차 처리 - Claude 호출 제한)
  if (!isJiraConfigured(config)) {
    onLog?.('[classifier] ⚠️  Jira 미설정 — Settings에서 Jira URL/Email/API Token/ProjectKey를 입력하면 더 정확한 분류가 가능합니다.');
  }

  for (let i = 0; i < enriched.length; i++) {
    if (shouldAbort?.()) break;
    const crash = enriched[i];
    const fingerprint = extractFingerprint(crash);

    // "None" 문자열은 유효한 issueKey가 아님 (crashReportOrganizer의 미매핑 표기)
    const validIssueKey = crash.issueKey && crash.issueKey !== 'None' ? crash.issueKey : undefined;

    onProgress?.({ current: i + 1, total, message: `분류 중: #${crash.id} ${crash.subject.slice(0, 40)}` });
    onLog?.(`[classifier] [${i + 1}/${total}] crash #${crash.id} | issueKey: ${validIssueKey ?? '없음'} | fp: ${fingerprint.slice(0, 60) || '(스택 없음)'}`);

    // 스택 없음 → 분석 불가
    if (!fingerprint) {
      results.push({
        crashId: crash.id,
        crashSubject: crash.subject,
        exceptionCode: crash.exceptionCode,
        osType: crash.osType,
        fingerprint: '',
        currentIssueKey: validIssueKey,
        verdict: 'no_stack',
        confidence: 'low',
        reason: '스택 정보가 없어 분석할 수 없습니다.',
      });
      continue;
    }

    // 범용 스택 → Claude 호출 없이 needs_analysis 반환
    if (isGenericStack(crash)) {
      onLog?.(`[classifier] → 범용 스택 감지 (시스템/런타임 프레임만 존재) — 분석 생략`);
      results.push({
        crashId: crash.id,
        crashSubject: crash.subject,
        exceptionCode: crash.exceptionCode,
        osType: crash.osType,
        fingerprint,
        currentIssueKey: validIssueKey,
        verdict: 'needs_analysis',
        confidence: 'low',
        reason: '스택이 시스템/런타임 프레임으로만 구성되어 특정 이슈와 연결할 수 없습니다. 덤프 분석이 필요합니다.',
      });
      continue;
    }

    let verdict: ClaudeVerdict;

    if (validIssueKey) {
      // issueKey 있음 → 매핑 검증
      if (isJiraConfigured(config)) {
        onLog?.(`[classifier] → issueKey ${validIssueKey} 검증 중...`);
        verdict = await validateMapping({ ...crash, issueKey: validIssueKey }, fingerprint, openIssues, config, onLog, shouldAbort, strict);
      } else {
        verdict = { verdict: 'validated', confidence: 'low', reason: 'Jira 미설정으로 검증 생략 (issueKey 있음)' };
      }
    } else {
      // issueKey 없음 → 기존 이슈 비교
      if (isJiraConfigured(config) && openIssues.length > 0) {
        onLog?.(`[classifier] → 미분류, ${openIssues.length}개 이슈와 비교 중...`);
        verdict = await classifyUnmapped(crash, fingerprint, openIssues, config, onLog, shouldAbort);
      } else if (!isJiraConfigured(config)) {
        verdict = { verdict: 'new_issue', confidence: 'low', reason: 'Jira 미설정으로 분류 불가' };
      } else {
        verdict = { verdict: 'new_issue', confidence: 'low', reason: '프로젝트에 열린 이슈가 없음' };
      }
    }

    results.push({
      crashId: crash.id,
      crashSubject: crash.subject,
      exceptionCode: crash.exceptionCode,
      osType: crash.osType,
      fingerprint,
      currentIssueKey: validIssueKey,
      verdict: verdict.verdict,
      confidence: verdict.confidence,
      reason: verdict.reason,
      suggestedIssueKey: verdict.suggestedIssueKey,
      suggestedIssueSummary: verdict.suggestedIssueSummary,
    });
  }

  return results;
}

/** 스택 정보가 없는 crash에 대해 detail API 호출 (5개씩 병렬) */
async function enrichWithDetails(
  crashes: CrashReport[],
  onLog?: (line: string) => void,
  shouldAbort?: () => boolean,
): Promise<CrashReport[]> {
  const needsDetail = crashes.filter(
    (c) => c.stackTraces.length === 0 && c.mainStackTraces.length === 0,
  );

  if (needsDetail.length === 0) return crashes;

  onLog?.(`[classifier] 스택 없는 crash ${needsDetail.length}개 detail 조회 중...`);

  const detailMap = new Map<number, CrashReport>();
  const CONCURRENCY = 5;

  for (let i = 0; i < needsDetail.length; i += CONCURRENCY) {
    if (shouldAbort?.()) break;
    const batch = needsDetail.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((c) => fetchReportDetail(c.id)),
    );
    for (const r of results) {
      if (r.status === 'fulfilled') {
        detailMap.set(r.value.id, r.value);
      }
    }
  }

  return crashes.map((c) => detailMap.get(c.id) ?? c);
}
