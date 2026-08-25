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

export interface PlannerTask {
  id: EntityId;
  workspaceId: EntityId;
  title: string;
  prompt: string;
  requestedAgentId: EntityId | null;
  requestedModelId: EntityId | null;
  priority: number;
  status: PlannerTaskStatus;
  visibleInPlanner: boolean;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
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

export interface Run {
  id: EntityId;
  taskId: EntityId;
  workspaceId: EntityId;
  resolvedAgentId: EntityId;
  resolvedModelId: EntityId;
  status: RunStatus;
  baseSha: string | null;
  worktreePath: string | null;
  startedAt: IsoTimestamp | null;
  finishedAt: IsoTimestamp | null;
  exitCode: number | null;
  resultSummary: string | null;
  failureReason: string | null;
  validationStatus: string | null;
  externalSessionId: string | null;
  finalHeadSha: string | null;
  finalGitState: string | null;
  createdAt: IsoTimestamp;
}

export interface RunEvent {
  id: EntityId;
  runId: EntityId;
  sequence: number;
  timestamp: IsoTimestamp;
  eventType: string;
  payload: unknown;
}

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
