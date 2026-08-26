import type { BatchStep, Run, RunEventKind, RunEventPage } from '@shared/domain/entities';
import type { RunNavigationItem } from '@shared/contracts/ipc';

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
  navigation(workspaceId: string): RunNavigationItem[];
  events(runId: string, kind?: RunEventKind, cursor?: number | null, limit?: number): RunEventPage;
  batchSteps(runId: string): BatchStep[];
  concurrencyLimit(): number;
  setConcurrencyLimit(limit: number): number;
  timeoutMs(): number;
  setTimeoutMs(timeoutMs: number): number;
  schedule(): void;
  requestCancellation(runId: string): Promise<Run>;
  publishCandidate(runId: string): Promise<Run>;
  createFollowUp(runId: string, prompt: string): Promise<Run>;
}
