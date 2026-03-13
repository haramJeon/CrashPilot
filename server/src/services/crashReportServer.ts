import { loadConfig } from './config';
import { CrashReport, ApiSoftware, ApiReport, ApiReportDetail } from '../types';

async function apiFetch<T>(path: string): Promise<T> {
  const config = loadConfig();
  const baseUrl = config.crashReportServer.url.replace(/\/$/, '');
  const res = await fetch(`${baseUrl}${path}`);
  if (!res.ok) throw new Error(`API error ${res.status}: ${path}`);
  return res.json() as Promise<T>;
}

export async function fetchSoftwares(): Promise<ApiSoftware[]> {
  return apiFetch<ApiSoftware[]>('/softwares/');
}

export async function fetchReports(softwareId: number, page = 1): Promise<CrashReport[]> {
  const config = loadConfig();
  const raw = await apiFetch<{ reports: any[] }>(
    `/reports/?software=${softwareId}&page=${page}`
  );

  return (raw.reports || []).map((r) => mapReport(r, softwareId));
}

export async function fetchReportDetail(reportId: number): Promise<CrashReport> {
  const raw = await apiFetch<ApiReportDetail>(`/reports/${reportId}`);
  return mapReportDetail(raw);
}

export async function fetchAllNewReports(): Promise<CrashReport[]> {
  const config = loadConfig();
  const softwareIds = config.crashReportServer.softwareIds;

  if (softwareIds.length === 0) {
    // Fetch all softwares and use all IDs
    const softwares = await fetchSoftwares();
    softwareIds.push(...softwares.map((s) => s.id));
  }

  const results: CrashReport[] = [];
  for (const softwareId of softwareIds) {
    try {
      const reports = await fetchReports(softwareId);
      results.push(...reports);
    } catch (e) {
      console.error(`Failed to fetch reports for software ${softwareId}:`, e);
    }
  }

  // Sort by date descending
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
  if (!report.swVersion) return 'main';
  // e.g. "2.1.3.456" → "release/2.1.3"
  const shortVersion = report.swVersion.split('.').slice(0, 3).join('.');
  return `${prefix}${shortVersion}`;
}
