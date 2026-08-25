import type { BatchStep, Run, RunEvent } from '@shared/domain/entities';

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
  list(workspaceId: string): Run[];
  events(runId: string): RunEvent[];
  batchSteps(runId: string): BatchStep[];
  schedule(): void;
  requestCancellation(runId: string): Promise<Run>;
  publishCandidate(runId: string): Promise<Run>;
  createFollowUp(runId: string, prompt: string): Promise<Run>;
}
