// Crash report entry (mapped from crashReportOrganizer API)
export interface CrashReport {
  id: number;
  subject: string;           // mail_title
  swVersion: string;         // sw_version (maps to git branch)
  releaseTag: string;        // git tag for this version (editable override)
  receivedAt: string;        // date_created
  dumpUrl: string;           // file_link
  exceptionCode?: string;    // EXCEPTION_CODE_STR
  bugcheck?: string;         // BUGCHECK_STR
  osType?: 'windows' | 'macos'; // derived from dumpUrl / exception fields
  issueKey?: string;            // Jira issue key (e.g. APOS-753)
  region?: string;
  country?: string;
  serialNo?: string;
  softwareId: number;
  softwareName?: string;
  stackTraces: StackEntry[];
  mainStackTraces: StackEntry[];
  status: CrashStatus;
  analysis?: CrashAnalysis;
  pipelineSteps?: PipelineStep[];
  prFixBranch?: string;      // manual override for PR head branch (fix branch)
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
    model: string;
  };
  debugger: DebuggerConfig;
  releaseBuildBaseDir: string; // local dir where release zips are extracted (PDBs + crash dumps)
  buildNetworkBaseDir: string; // UNC base path to release zips, e.g. \\10.100.1.20\Build_Repository\Product_Release
  softwareBuildPaths: Record<string, string>; // softwareId → subfolder under buildNetworkBaseDir
  git: {
    repoUrl: string;        // e.g. https://github.com/org/repo.git
    repoBaseDir: string;    // base folder; each branch cloned into a subfolder
    branchPrefix: string;   // e.g. "release/" → sw_version "2.1.3.4" → "release/2.1.3"
    defaultBranch: string;  // fallback when sw_version is empty (e.g. "master")
    softwareTagFolders: Record<string, string>; // softwareId (as string) → tag root folder
  };
}

export interface PipelineStep {
  name: string;
  status: 'pending' | 'running' | 'done' | 'error' | 'awaiting';
  message?: string;
  logs?: string[];
}

export interface PipelineRunHistory {
  crashId: string;
  runAt: string;
  status: 'completed' | 'error';
  releaseTag?: string;
  steps: PipelineStep[];
  analysis?: CrashAnalysis;
  errorMessage?: string;
  pipelineState?: PipelineState;
}

export interface PipelineState {
  pdbDir: string;
  dmpPath: string;
  cdbTxtPath: string;
  cdbCallStack: string;
  cdbExceptionType: string;
  cdbFaultingModule: string;
  releaseBranch: string;
  fixBranch?: string;
}

// Raw types from crashReportOrganizer API
export interface ApiSoftware {
  id: number;
  name: string;
}

export interface ApiReport {
  id: number;
  // snake_case (legacy / some endpoints)
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
  issue_key?: string;
  // camelCase (detail endpoint)
  swVersion?: string;
  fileLink?: string;
  dateCreated?: string;
  serialNo?: string;
  softwareId?: number;
  subject?: string;
  version?: string;  // list endpoint uses 'version' instead of 'sw_version'
}

export interface ApiReportDetail extends ApiReport {
  stackTraces: { id: number; dllName: string; functionName?: string }[];
  mainStackTraces: { id: number; dllName: string; functionName?: string }[];
  pcInfo: { type: string; key: string; value: string }[];
}
