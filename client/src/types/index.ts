export interface CrashReport {
  id: number;
  subject: string;
  swVersion: string;
  releaseTag: string;
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
  pipelineSteps?: PipelineStep[];
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
    model: string;
  };
  github: {
    token: string;
    owner: string;
    repo: string;
  };
  debugger: DebuggerConfig;
  releaseBuildBaseDir: string;
  buildNetworkBaseDir: string;
  softwareBuildPaths: Record<string, string>;
  crashDb: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
  };
  git: {
    repoUrl: string;
    repoBaseDir: string;
    branchPrefix: string;
    defaultBranch: string;
    softwareTagFolders: Record<string, string>;
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
  pipelineState?: Record<string, string>;
}

export interface ApiSoftware {
  id: number;
  name: string;
}
