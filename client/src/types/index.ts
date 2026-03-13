export interface CrashReport {
  id: number;
  subject: string;
  swVersion: string;
  receivedAt: string;
  dumpUrl: string;
  exceptionCode?: string;
  bugcheck?: string;
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
  windows: { cdbPath: string; symbolPath: string };
  macos: { lldbPath: string; dsymPath: string };
}

export interface AppConfig {
  crashReportServer: {
    url: string;
    softwareIds: number[];
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
    branchPrefix: string;
    defaultBranch: string;
  };
}

export interface PipelineStep {
  name: string;
  status: 'pending' | 'running' | 'done' | 'error';
  message?: string;
}

export interface ApiSoftware {
  id: number;
  name: string;
}
