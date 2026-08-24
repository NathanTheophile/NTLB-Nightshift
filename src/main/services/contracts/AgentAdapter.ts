import type { AgentCapabilities, AgentDescriptor, IsolationMode, WorkerPermissionProfile } from '@shared/domain/entities';

export interface RunStartSpec {
  runId: string;
  workspaceId: string;
  workingDirectory: string;
  prompt: string;
  modelId: string;
}

export interface WorkerStartSpec {
  workerId: string;
  workspaceId: string;
  workingDirectory: string;
  modelId: string;
  permissionProfile: WorkerPermissionProfile;
  isolationMode: IsolationMode;
}

export interface AgentExecutionHandle {
  handleId: string;
  externalSessionId: string | null;
}

export interface AgentAdapter {
  readonly id: string;
  detect(): Promise<AgentDescriptor>;
  capabilities(): AgentCapabilities;
  startWorker(spec: WorkerStartSpec): Promise<AgentExecutionHandle>;
  startRun(spec: RunStartSpec): Promise<AgentExecutionHandle>;
  cancel(handleId: string): Promise<void>;
  resume?(sessionId: string): Promise<AgentExecutionHandle>;
}

export interface AgentRegistry {
  refresh(): Promise<readonly AgentDescriptor[]>;
  listDetected(): readonly AgentDescriptor[];
  findAdapter(agentId: string): AgentAdapter | undefined;
}
