import type { Run } from '@shared/domain/entities';

export interface PrepareRunSpec {
  taskId: string;
  workspaceId: string;
  resolvedAgentId: string;
  resolvedModelId: string;
  baseSha: string;
}

export interface RunService {
  createAttempt(spec: PrepareRunSpec): Promise<Run>;
  find(runId: string): Promise<Run | undefined>;
  requestCancellation(runId: string): Promise<Run>;
}
