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
    try {
      const reports = await fetchReports(softwareId, filter);
      results.push(...reports);
    } catch (e) {
      console.error(`Failed to fetch reports for software ${softwareId}:`, e);
    }
  }

  return results.sort(
    (a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime()
  );
}

function mapReport(r: any, softwareId: number): CrashReport {
  return {
    id: r.id,
    subject: r.mail_title || r.subject || `Crash #${r.id}`,
    swVersion: r.sw_version || r.version || '',
    receivedAt: r.date_created || r.date || new Date().toISOString(),
    dumpUrl: r.file_link || r.fileLink || '',
    exceptionCode: r.EXCEPTION_CODE_STR || r.exceptionCode,
    bugcheck: r.BUGCHECK_STR || r.bugcheck,
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
  const config = loadConfig();
  const branchPrefix = config.git.branchPrefix || 'release/';

  return {
    id: r.id,
    subject: r.mail_title || `Crash #${r.id}`,
    swVersion: r.sw_version || '',
    receivedAt: r.date_created || r.date || new Date().toISOString(),
    dumpUrl: r.file_link || '',
    exceptionCode: r.EXCEPTION_CODE_STR,
    bugcheck: r.BUGCHECK_STR,
    region: r.region,
    country: r.country,
    serialNo: r.serial_no,
    softwareId: r.software_id || 0,
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

export function getReleaseBranch(report: CrashReport): string {
  const config = loadConfig();
  const prefix = config.git.branchPrefix || 'release/';
  const defaultBranch = config.git.defaultBranch || 'master';

  if (!report.swVersion) return defaultBranch;

  // e.g. "2.1.3.456" → "release/2.1.3"
  const parts = report.swVersion.split('.');
  const shortVersion = parts.slice(0, 3).join('.');
  return `${prefix}${shortVersion}`;
}
