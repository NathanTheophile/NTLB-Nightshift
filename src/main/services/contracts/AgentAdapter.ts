import type { AgentCapabilities, AgentDescriptor, IsolationMode, PlannerExecutionMode, WorkerPermissionProfile } from '@shared/domain/entities';

export interface RunStartSpec {
  runId: string;
  workspaceId: string;
  workingDirectory: string;
  prompt: string;
  modelId: string;
  onProtocolEvent?: (event: AgentProtocolEvent) => void;
}

export interface WorkerStartSpec {
  workerId: string;
  workspaceId: string;
  workingDirectory: string;
  modelId: string;
  permissionProfile: WorkerPermissionProfile;
  isolationMode: IsolationMode;
  prompt: string;
  externalSessionId: string | null;
  onProtocolEvent?: (event: AgentProtocolEvent) => void;
}

export interface AgentExecutionHandle {
  handleId: string;
  externalSessionId: string | null;
  events: readonly AgentProtocolEvent[];
  completion: Promise<AgentExecutionResult>;
}

export interface AgentProtocolEvent {
  sequence: number;
  timestamp: string;
  raw: string;
  parsed: unknown;
  type: string | null;
  externalSessionId: string | null;
  terminal: boolean;
  parseError: string | null;
}

export interface AgentExecutionResult {
  handleId: string;
  succeeded: boolean;
  failureReason: string | null;
  exitCode: number | null;
  signal: string | null;
  externalSessionId: string | null;
  events: readonly AgentProtocolEvent[];
  terminalEvent: AgentProtocolEvent | null;
  stderr: string;
}

export interface AgentAdapter {
  readonly id: string;
  detect(): Promise<AgentDescriptor>;
  capabilities(): AgentCapabilities;
  startWorker(spec: WorkerStartSpec): Promise<AgentExecutionHandle>;
  startRun(spec: RunStartSpec): Promise<AgentExecutionHandle>;
  cancel(handleId: string): Promise<void>;
  supportsExecutionMode(executionMode: PlannerExecutionMode): boolean;
  supportsModelForExecutionMode(executionMode: PlannerExecutionMode, modelId: string): boolean;
  /** Explicit compatibility evidence for unattended Planner execution. */
  supportsPlannerModel?(modelId: string): boolean;
  /** Explicit compatibility evidence for structured Worker execution. */
  supportsWorkerModel?(modelId: string): boolean;
  resume?(sessionId: string): Promise<AgentExecutionHandle>;
}

export interface AgentRegistry {
  refresh(): Promise<readonly AgentDescriptor[]>;
  listDetected(): readonly AgentDescriptor[];
  findAdapter(agentId: string): AgentAdapter | undefined;
}
