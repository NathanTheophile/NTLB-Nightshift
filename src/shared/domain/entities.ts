export type EntityId = string;
export type IsoTimestamp = string;

export interface Workspace {
  id: EntityId;
  rootPath: string;
  displayName: string;
  isGit: boolean;
  createdAt: IsoTimestamp;
  lastOpenedAt: IsoTimestamp;
}

export type PlannerTaskStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'cancelled';

export type PlannerExecutionMode = 'single_agent' | 'sequential_batch';
export type BatchStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out';

export interface PlannerTask {
  id: EntityId;
  workspaceId: EntityId;
  title: string;
  prompt: string;
  requestedAgentId: EntityId | null;
  requestedModelId: EntityId | null;
  executionMode: PlannerExecutionMode;
  priority: number;
  status: PlannerTaskStatus;
  visibleInPlanner: boolean;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface BatchStep {
  id: EntityId;
  runId: EntityId;
  stepIndex: number;
  prompt: string;
  status: BatchStepStatus;
  startedAt: IsoTimestamp | null;
  finishedAt: IsoTimestamp | null;
  externalSessionId: string | null;
  resultSummary: string | null;
  failureReason: string | null;
}

export type RunStatus =
  | 'preparing'
  | 'running'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'cancel_requested'
  | 'cancelled'
  | 'timed_out';

export type ValidationStatus = 'not_configured' | 'running' | 'passed' | 'failed' | 'interrupted';
export type ValidationCommandStatus = 'running' | 'passed' | 'failed' | 'interrupted';

export type CandidatePublishState = 'not_published' | 'publishing' | 'published' | 'failed';
export type ReviewerVerdict = 'PASS' | 'FAIL' | 'NEEDS_ATTENTION';
export type IntegrationStatus = 'not_started' | 'integrating' | 'integrated' | 'needs_attention' | 'rejected';

export interface RunIntegrationReview {
  id: EntityId;
  runId: EntityId;
  candidateSha: string;
  targetDevSha: string;
  reviewerAgentId: string;
  reviewerModelId: string;
  verdict: ReviewerVerdict;
  summary: string;
  findings: string;
  createdAt: IsoTimestamp;
  reviewedAt: IsoTimestamp;
  staleAt: IsoTimestamp | null;
  staleReason: string | null;
  integrationStatus: IntegrationStatus;
  integrationCommitSha: string | null;
  integrationValidation: string | null;
  integrationFailureReason: string | null;
  integratedAt: IsoTimestamp | null;
  integrationValidationCommands: IntegrationValidationCommand[];
}
export interface IntegrationValidationCommand {
  id: EntityId;
  reviewId: EntityId;
  sequence: number;
  command: string;
  status: ValidationCommandStatus;
  startedAt: IsoTimestamp;
  finishedAt: IsoTimestamp | null;
  exitCode: number | null;
  output: string;
  outputTruncated: boolean;
}

export interface Run {
  id: EntityId;
  taskId: EntityId;
  workspaceId: EntityId;
  resolvedAgentId: EntityId;
  resolvedModelId: EntityId;
  executionMode: PlannerExecutionMode;
  status: RunStatus;
  sourceRunId: EntityId | null;
  followUpPrompt: string | null;
  baseSha: string | null;
  worktreePath: string | null;
  startedAt: IsoTimestamp | null;
  finishedAt: IsoTimestamp | null;
  exitCode: number | null;
  resultSummary: string | null;
  failureReason: string | null;
  validationStatus: ValidationStatus | null;
  externalSessionId: string | null;
  finalHeadSha: string | null;
  finalGitState: string | null;
  candidateBranchName: string | null;
  candidateCommitSha: string | null;
  candidateRemoteName: string | null;
  candidatePublishState: CandidatePublishState;
  candidatePublishedAt: IsoTimestamp | null;
  candidateFailureReason: string | null;
  createdAt: IsoTimestamp;
}

export interface RunValidationCommand {
  id: EntityId;
  runId: EntityId;
  sequence: number;
  profileId: string;
  command: string;
  status: ValidationCommandStatus;
  startedAt: IsoTimestamp;
  finishedAt: IsoTimestamp | null;
  exitCode: number | null;
  output: string;
  outputTruncated: boolean;
}

export interface RunEvent {
  id: EntityId;
  runId: EntityId;
  sequence: number;
  timestamp: IsoTimestamp;
  eventType: string;
  payload: unknown;
}
export type RunEventKind = 'activity' | 'raw_protocol';
export interface RunEventPage { events: RunEvent[]; total: number; nextCursor: number | null; }

export type RunChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'unknown';
export interface RunChangedFile {
  path: string;
  previousPath: string | null;
  kind: RunChangeKind;
  staged: boolean;
  unstaged: boolean;
  isBinary: boolean;
  sizeBytes: number | null;
  diffAvailable: boolean;
  note: string | null;
  additions: number | null;
  deletions: number | null;
}
export interface RunFileDiff {
  path: string;
  content: string | null;
  isBinary: boolean;
  truncated: boolean;
  note: string | null;
}
export interface RunReview {
  run: Run;
  worktreeHead: string | null;
  gitStatus: string;
  changedFiles: RunChangedFile[];
  result: string | null;
  failure: string | null;
  validationStatus: string | null;
  validationCommands: RunValidationCommand[];
  batchSteps: BatchStep[];
  activityTotal: number;
  rawProtocolTotal: number;
  warnings: string[];
}
export type RunReviewExportKind = 'markdown' | 'json' | 'bundle';
export interface RunReviewExportResult { path: string; kind: RunReviewExportKind; }

export type WorkerStatus = 'idle' | 'starting' | 'active' | 'waiting_for_user' | 'terminated' | 'error';
export type WorkerPermissionProfile = 'read_only' | 'workspace_write' | 'isolated_write';
export type IsolationMode = 'direct_workspace' | 'isolated_worktree';
export type AgentRenderMode = 'structured' | 'terminal' | 'hybrid';

export interface WorkerConversation {
  id: EntityId;
  workspaceId: EntityId;
  title: string;
  agentId: EntityId;
  modelId: EntityId;
  permissionProfile: WorkerPermissionProfile;
  isolationMode: IsolationMode;
  externalSessionId: string | null;
  workingDirectory: string;
  baseSha: string | null;
  status: WorkerStatus;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface WorkerEvent {
  id: EntityId;
  workerId: EntityId;
  sequence: number;
  timestamp: IsoTimestamp;
  roleOrType: string;
  content: string | null;
  payload: unknown;
}

export interface ChatConversation {
  id: EntityId;
  workspaceId: EntityId;
  title: string;
  modelId: EntityId;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface AgentCapabilities {
  interactive: boolean;
  headless: boolean;
  structuredEvents: boolean;
  rawPty: boolean;
  resume: boolean;
  modelOverride: boolean;
  cancel: boolean;
  workingDirectory: boolean;
  imageInput: boolean;
  subagents: boolean;
  plannerValidated: boolean;
  workerValidated: boolean;
  renderMode: AgentRenderMode;
}

export interface AgentDescriptor {
  id: EntityId;
  displayName: string;
  fccLauncher: string;
  installed: boolean;
  launchable: boolean;
  version: string | null;
  capabilities: AgentCapabilities;
  lastValidatedAt: IsoTimestamp | null;
}

export interface ModelDescriptor {
  id: EntityId;
  providerId: string;
  displayName: string;
  rawModelRef: string;
  lastSeenAt: IsoTimestamp;
}
