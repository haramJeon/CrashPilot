/**
 * Jira service — READ-ONLY
 * Issue 생성/수정은 절대 자동으로 하지 않음. 조회만 허용.
 */
import { AppConfig, JiraIssue } from '../types';

function getAuthHeader(config: AppConfig): string {
  const { email, apiToken } = config.jira!;
  return 'Basic ' + Buffer.from(`${email}:${apiToken}`).toString('base64');
}

function isJiraConfigured(config: AppConfig): boolean {
  return !!(config.jira?.url && config.jira?.email && config.jira?.apiToken);
}

/** ADF(Atlassian Document Format) → plain text */
function extractAdfText(node: any): string {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.text) return node.text;
  if (Array.isArray(node.content)) {
    return node.content.map(extractAdfText).filter(Boolean).join(' ');
  }
  return '';
}

async function jiraFetch<T>(config: AppConfig, path: string, params?: Record<string, string>): Promise<T> {
  if (!isJiraConfigured(config)) {
    throw new Error('Jira가 설정되지 않았습니다. Settings에서 Jira URL, Email, API Token을 입력하세요.');
  }
  const baseUrl = config.jira!.url.replace(/\/$/, '');
  const url = new URL(`${baseUrl}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString(), {
    headers: {
      Authorization: getAuthHeader(config),
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Jira API error ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

/** 단일 이슈 조회 (read-only) */
export async function fetchJiraIssue(config: AppConfig, issueKey: string): Promise<JiraIssue> {
  const data = await jiraFetch<any>(config, `/rest/api/3/issue/${issueKey}`, {
    fields: 'summary,status,issuetype,description',
  });
  return {
    key: data.key,
    summary: data.fields.summary ?? '',
    status: data.fields.status?.name ?? '',
    issueType: data.fields.issuetype?.name ?? '',
    description: extractAdfText(data.fields.description).slice(0, 500),
  };
}

/** JQL로 이슈 목록 조회 (read-only) */
export async function searchJiraIssues(
  config: AppConfig,
  jql: string,
  maxResults = 50,
): Promise<JiraIssue[]> {
  const data = await jiraFetch<any>(config, '/rest/api/3/search', {
    jql,
    maxResults: String(maxResults),
    fields: 'summary,status,issuetype,description',
  });
  return (data.issues ?? []).map((issue: any) => ({
    key: issue.key,
    summary: issue.fields.summary ?? '',
    status: issue.fields.status?.name ?? '',
    issueType: issue.fields.issuetype?.name ?? '',
    description: extractAdfText(issue.fields.description).slice(0, 300),
  }));
}

/**
 * 열린 이슈 목록 조회 (read-only)
 * @param projectKeys crash의 issueKey에서 자동 추출한 프로젝트 키 목록 (e.g. ["APOS"])
 *                    없으면 전체 프로젝트에서 조회 (너무 많을 수 있으므로 projectKeys 권장)
 */
export async function fetchOpenIssues(
  config: AppConfig,
  projectKeys: string[],
  maxResults = 100,
): Promise<JiraIssue[]> {
  let jql: string;
  if (projectKeys.length > 0) {
    const projectList = projectKeys.map((k) => `"${k}"`).join(', ');
    jql = `project in (${projectList}) AND statusCategory != Done ORDER BY updated DESC`;
  } else {
    jql = `statusCategory != Done ORDER BY updated DESC`;
  }
  return searchJiraIssues(config, jql, maxResults);
}

export { isJiraConfigured };
