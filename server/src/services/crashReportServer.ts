import { loadConfig } from './config';
import { CrashReport, ApiSoftware, ApiReport, ApiReportDetail } from '../types';

async function apiFetch<T>(path: string): Promise<T> {
  const config = loadConfig();
  const baseUrl = config.crashReportServer.url.replace(/\/$/, '');
  const fullUrl = `${baseUrl}${path}`;
  console.log(`[crashReportServer] GET ${fullUrl}`);
  const res = await fetch(fullUrl);
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    throw new Error(`Expected JSON but got ${contentType} from ${fullUrl} (status ${res.status})`);
  }
  if (!res.ok) throw new Error(`API error ${res.status}: ${fullUrl}`);
  return res.json() as Promise<T>;
}

export async function fetchSoftwares(): Promise<ApiSoftware[]> {
  return apiFetch<ApiSoftware[]>('/softwares/');
}

export interface FetchFilter {
  softwareId?: number;   // 0 or undefined = all
  startDate?: string;    // YYYY-MM-DD
  endDate?: string;      // YYYY-MM-DD
}

export async function fetchReports(
  softwareId: number,
  filter: FetchFilter = {},
  page = 1
): Promise<CrashReport[]> {
  let qs = `software=${softwareId}&page=${page}`;
  if (filter.startDate) qs += `&start=${filter.startDate}`;
  if (filter.endDate)   qs += `&end=${filter.endDate}`;

  const raw = await apiFetch<{ reports: any[] }>(`/reports/?${qs}`);
  return (raw.reports || []).map((r) => mapReport(r, softwareId));
}

export async function fetchReportDetail(reportId: number): Promise<CrashReport> {
  const raw = await apiFetch<ApiReportDetail>(`/reports/${reportId}`);
  return mapReportDetail(raw);
}

export async function fetchAllNewReports(filter: FetchFilter = {}): Promise<CrashReport[]> {
  const config = loadConfig();
  let softwareIds = [...config.crashReportServer.softwareIds];

  // If a specific software is selected in the filter, use only that
  if (filter.softwareId && filter.softwareId !== 0) {
    softwareIds = [filter.softwareId];
  } else if (softwareIds.length === 0) {
    // No config restriction → fetch all
    const softwares = await fetchSoftwares();
    softwareIds = softwares.map((s) => s.id);
  }

  const results: CrashReport[] = [];
  for (const softwareId of softwareIds) {
    let page = 1;
    while (true) {
      try {
        const reports = await fetchReports(softwareId, filter, page);
        if (reports.length === 0) break;
        results.push(...reports);
        page++;
      } catch (e) {
        console.error(`Failed to fetch reports for software ${softwareId} page ${page}:`, e);
        break;
      }
    }
  }

  return results.sort(
    (a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime()
  );
}

// Determine OS from pcInfo (detail API only).
// The "Version" entry under type "Windows" holds the actual OS string in its value,
// e.g. "Microsoft Windows 11 Pro" or "macOS 14.4.1".
function detectOsFromPcInfo(pcInfo: { type: string; key: string; value: string }[]): 'windows' | 'macos' | undefined {
  const versionEntry = pcInfo.find((e) => e.key === 'Version' && e.type === 'Windows');
  if (!versionEntry) return undefined;
  const v = versionEntry.value.toLowerCase();
  if (v.includes('macos') || v.includes('mac os')) return 'macos';
  if (v.includes('windows')) return 'windows';
  return undefined;
}

function mapReport(r: any, softwareId: number): CrashReport {
  const swVersion = r.sw_version || r.version || '';
  return {
    id: r.id,
    subject: r.mail_title || r.subject || `Crash #${r.id}`,
    swVersion,
    releaseTag: '',
    receivedAt: r.date_created || r.date || new Date().toISOString(),
    dumpUrl: r.file_link || r.fileLink || '',
    exceptionCode: r.EXCEPTION_CODE_STR || r.exceptionCode,
    bugcheck: r.BUGCHECK_STR || r.bugcheck,
    // osType not available from list API — populated later via fetchReportDetail
    issueKey: r.issue_key || r.issueKey,
    region: r.region,
    country: r.country,
    serialNo: r.serial_no || r.serialNo,
    softwareId,
    stackTraces: [],
    mainStackTraces: [],
    status: 'new',
  };
}

function mapReportDetail(r: ApiReportDetail): CrashReport {
  return {
    id: r.id,
    subject: r.mail_title || r.subject || `Crash #${r.id}`,
    swVersion: r.sw_version || r.swVersion || r.version || '',
    releaseTag: '',
    receivedAt: r.date_created || r.dateCreated || r.date || new Date().toISOString(),
    dumpUrl: r.file_link || r.fileLink || '',
    exceptionCode: r.EXCEPTION_CODE_STR,
    bugcheck: r.BUGCHECK_STR,
    osType: detectOsFromPcInfo(r.pcInfo || []),
    issueKey: r.issue_key,
    region: r.region,
    country: r.country,
    serialNo: r.serial_no || r.serialNo,
    softwareId: r.software_id || r.softwareId || 0,
    stackTraces: (r.stackTraces || []).map((s) => ({
      id: s.id,
      dllName: s.dllName,
      functionName: s.functionName,
    })),
    mainStackTraces: (r.mainStackTraces || []).map((s) => ({
      id: s.id,
      dllName: s.dllName,
      functionName: s.functionName,
    })),
    status: 'new',
  };
}

export function formatCallStack(report: CrashReport): string {
  const frames = [...report.stackTraces, ...report.mainStackTraces];
  if (frames.length === 0) return '(no stack trace)';

  return frames
    .map((f, i) => {
      const fn = f.functionName ? `${f.dllName}!${f.functionName}` : f.dllName;
      return `  #${i} ${fn}`;
    })
    .join('\n');
}

