export interface SupervisedProcessSpec {
  executionId: string;
  executablePath: string;
  arguments: readonly string[];
  workingDirectory: string;
  environment: Readonly<Record<string, string>>;
}

export interface SupervisedProcessSnapshot {
  executionId: string;
  processId: number;
  startedAt: string;
  lastOutputAt: string | null;
  cancellationRequested: boolean;
  exitCode: number | null;
}

export interface ProcessSupervisor {
  start(spec: SupervisedProcessSpec): Promise<SupervisedProcessSnapshot>;
  snapshot(executionId: string): SupervisedProcessSnapshot | undefined;
  cancelOwnedTree(executionId: string): Promise<void>;
}
