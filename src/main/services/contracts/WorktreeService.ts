export interface WorktreeSpec {
  runId: string;
  repositoryRoot: string;
  baseSha: string;
}

export interface WorktreeHandle {
  path: string;
  baseSha: string;
  branchName: string;
}

export interface WorktreeService {
  createForRun(spec: WorktreeSpec): Promise<WorktreeHandle>;
  inspect(path: string): Promise<WorktreeHandle | undefined>;
  removeAfterEvidencePersisted(path: string): Promise<void>;
}
