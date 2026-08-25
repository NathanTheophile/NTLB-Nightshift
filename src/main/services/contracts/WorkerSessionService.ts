import type { IsolationMode, WorkerConversation, WorkerEvent, WorkerPermissionProfile } from '@shared/domain/entities';

export interface CreateWorkerConversationSpec {
  workspaceId: string;
  title: string;
  agentId: string;
  modelId: string;
  permissionProfile: WorkerPermissionProfile;
  isolationMode: IsolationMode;
}

export interface WorkerSessionService {
  create(spec: CreateWorkerConversationSpec): Promise<WorkerConversation>;
  find(workerId: string): Promise<WorkerConversation | undefined>;
  list(workspaceId: string): Promise<WorkerConversation[]>;
  events(workerId: string): Promise<WorkerEvent[]>;
  send(workerId: string, message: string): Promise<WorkerConversation>;
  terminate(workerId: string): Promise<WorkerConversation>;
}
