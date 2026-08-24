export interface SupervisedProcessSpec {
  executionId: string;
  executablePath: string;
  arguments: readonly string[];
  workingDirectory: string;
  environment: Readonly<Record<string, string>>;
}

export type SupervisedProcessState = 'starting' | 'running' | 'cancelling' | 'exited' | 'failed';
export type SupervisedProcessOutputStream = 'stdout' | 'stderr';

interface SupervisedProcessEventBase {
  executionId: string;
  sequence: number;
  observedAt: string;
}

export interface SupervisedProcessStartedEvent extends SupervisedProcessEventBase {
  type: 'started';
  processId: number;
}

export interface SupervisedProcessOutputEvent extends SupervisedProcessEventBase {
  type: 'output';
  stream: SupervisedProcessOutputStream;
  chunk: string;
}

export interface SupervisedProcessCancellationEvent extends SupervisedProcessEventBase {
  type: 'cancellation_requested';
}

export interface SupervisedProcessExitEvent extends SupervisedProcessEventBase {
  type: 'exit';
  exitCode: number | null;
  signal: string | null;
}

export interface SupervisedProcessFailureEvent extends SupervisedProcessEventBase {
  type: 'failure';
  detail: string;
}

export type SupervisedProcessEvent =
  | SupervisedProcessStartedEvent
  | SupervisedProcessOutputEvent
  | SupervisedProcessCancellationEvent
  | SupervisedProcessExitEvent
  | SupervisedProcessFailureEvent;

export type SupervisedProcessEventListener = (event: SupervisedProcessEvent) => void;

export interface SupervisedProcessSnapshot {
  executionId: string;
  processId: number | null;
  state: SupervisedProcessState;
  startedAt: string | null;
  lastOutputAt: string | null;
  finishedAt: string | null;
  cancellationRequested: boolean;
  exitCode: number | null;
  failureReason: string | null;
}

export interface SupervisedProcessResult extends SupervisedProcessSnapshot {
  signal: string | null;
  stdout: string;
  stderr: string;
}

export interface ProcessSupervisor {
  start(spec: SupervisedProcessSpec): Promise<SupervisedProcessSnapshot>;
  snapshot(executionId: string): SupervisedProcessSnapshot | undefined;
  subscribe(executionId: string, listener: SupervisedProcessEventListener, replay?: boolean): () => void;
  waitForCompletion(executionId: string): Promise<SupervisedProcessResult>;
  cancelOwnedTree(executionId: string): Promise<void>;
}
