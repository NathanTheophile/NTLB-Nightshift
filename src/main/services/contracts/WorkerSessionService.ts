import type { WorkerConversation } from '@shared/domain/entities';

import type { WorkerStartSpec } from './AgentAdapter';

export interface WorkerSessionService {
  create(spec: WorkerStartSpec): Promise<WorkerConversation>;
  find(workerId: string): Promise<WorkerConversation | undefined>;
  terminate(workerId: string): Promise<WorkerConversation>;
}
