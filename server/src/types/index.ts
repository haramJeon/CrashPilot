// Crash report entry (mapped from crashReportOrganizer API)
export interface CrashReport {
  id: number;
  subject: string;           // mail_title
  swVersion: string;         // sw_version (maps to git branch)
  receivedAt: string;        // date_created
  dumpUrl: string;           // file_link
  exceptionCode?: string;    // EXCEPTION_CODE_STR
  bugcheck?: string;         // BUGCHECK_STR
  region?: string;
  country?: string;
  serialNo?: string;
  softwareId: number;
  softwareName?: string;
  stackTraces: StackEntry[];
  mainStackTraces: StackEntry[];
  status: CrashStatus;
  analysis?: CrashAnalysis;
}

export interface StackEntry {
  id?: number;
  dllName: string;
  functionName?: string;
}

export type CrashStatus =
  | 'new'
  | 'analyzing'
  | 'fixing'
  | 'creating_pr'
  | 'completed'
  | 'error';

export interface CrashAnalysis {
  callStack: string;
  exceptionType: string;
  rootCause: string;
  suggestedFix: string;
  fixedFiles: FixedFile[];
  prUrl?: string;
}

export interface FixedFile {
  path: string;
  original: string;
  modified: string;
  diff: string;
}

export type Platform = 'windows' | 'macos';

export interface DebuggerConfig {
  windows: {
    cdbPath: string;
    symbolPath: string;
  };
  macos: {
    lldbPath: string;
    dsymPath: string;
  };
}

export interface AppConfig {
  crashReportServer: {
    url: string;          // e.g. http://rnd3.meditlink.com:5000
    softwareIds: number[]; // software IDs to watch
  };
  claude: {
    apiKey: string;
  };
  github: {
    token: string;
    owner: string;
    repo: string;
  };
  debugger: DebuggerConfig;
  git: {
    repoPath: string;
    branchPrefix: string;   // e.g. "release/" → sw_version "2.1.3.4" → "release/2.1.3"
    defaultBranch: string;  // fallback when sw_version is empty (e.g. "master")
  };
}

export interface PipelineStep {
  name: string;
  status: 'pending' | 'running' | 'done' | 'error';
  message?: string;
}

// Raw types from crashReportOrganizer API
export interface ApiSoftware {
  id: number;
  name: string;
}

export interface ApiReport {
  id: number;
  mail_title?: string;
  date?: string;
  date_created?: string;
  sw_version?: string;
  file_link?: string;
  EXCEPTION_CODE_STR?: string;
  BUGCHECK_STR?: string;
  region?: string;
  country?: string;
  serial_no?: string;
  software_id?: number;
}

export interface ApiReportDetail extends ApiReport {
  stackTraces: { id: number; dllName: string; functionName?: string }[];
  mainStackTraces: { id: number; dllName: string; functionName?: string }[];
  pcInfo: { type: string; key: string; value: string }[];
}
