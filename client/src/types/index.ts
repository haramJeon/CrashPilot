export interface CrashReport {
  id: number;
  subject: string;
  swVersion: string;
  releaseTag: string;
  receivedAt: string;
  dumpUrl: string;
  exceptionCode?: string;
  bugcheck?: string;
  osType?: 'windows' | 'macos';
  issueKey?: string;
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
  prFixBranch?: string;
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
  debugger: DebuggerConfig;
  releaseBuildBaseDir: string;
  buildNetworkBaseDir: string;
  softwareBuildPaths: Record<string, string>;
  git: {
    repoUrl: string;
    repoBaseDir: string;
    branchPrefix: string;
    defaultBranch: string;
    softwareTagFolders: Record<string, string>;
  };
  jira?: {
    url: string;
    email: string;
    apiToken: string;
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

// ─────────────────────────────────────────────────────────────────────────
// Classification
// ─────────────────────────────────────────────────────────────────────────

export type ClassificationVerdict =
  | 'validated'
  | 'misclassified'
  | 'assign'
  | 'new_issue';

export interface ClassificationResult {
  crashId: number;
  crashSubject: string;
  exceptionCode?: string;
  fingerprint: string;
  currentIssueKey?: string;
  verdict: ClassificationVerdict;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  suggestedIssueKey?: string;
  suggestedIssueSummary?: string;
}

export interface ClassificationRun {
  id: string;
  runAt: string;
  softwareId: number;
  softwareName?: string;
  startDate: string;
  endDate: string;
  totalCrashes: number;
  processedCrashes: number;
  results: ClassificationResult[];
  status: 'running' | 'completed' | 'error';
  errorMessage?: string;
}
