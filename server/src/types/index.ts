export interface CrashEmail {
  id: string;
  subject: string;
  from: string;
  receivedAt: string;
  body: string;
  dumpUrl: string;
  releaseBranch: string;
  status: CrashStatus;
  analysis?: CrashAnalysis;
}

export type CrashStatus =
  | 'new'
  | 'downloading'
  | 'analyzing'
  | 'fixing'
  | 'creating_pr'
  | 'completed'
  | 'error';

export interface CrashAnalysis {
  callStack: string;
  exceptionType: string;
  exceptionMessage: string;
  faultingModule: string;
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
  outlook: {
    clientId: string;
    tenantId: string;
    mailFilter: string;
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
  };
}

export interface PipelineStep {
  name: string;
  status: 'pending' | 'running' | 'done' | 'error';
  message?: string;
}
