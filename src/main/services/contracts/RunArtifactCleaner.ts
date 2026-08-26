import type { Run } from '@shared/domain/entities';

export interface RunArtifactCleaner {
  removeForRuns(runs: readonly Run[]): Promise<void>;
}
