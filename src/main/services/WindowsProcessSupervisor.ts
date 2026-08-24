import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

import type {
  ProcessSupervisor,
  SupervisedProcessEvent,
  SupervisedProcessEventListener,
  SupervisedProcessResult,
  SupervisedProcessSnapshot,
  SupervisedProcessSpec,
} from './contracts/ProcessSupervisor';

const KILL_TIMEOUT_MS = 5_000;
const NON_WINDOWS_GRACE_MS = 1_000;

interface OwnedProcessRecord {
  child: ChildProcess;
  snapshot: SupervisedProcessSnapshot;
  events: SupervisedProcessEvent[];
  listeners: Set<SupervisedProcessEventListener>;
  stdout: string[];
  stderr: string[];
  completion: Promise<SupervisedProcessResult>;
  cancellation: Promise<void> | null;
  resolveCompletion: (result: SupervisedProcessResult) => void;
  sequence: number;
  signal: string | null;
  settled: boolean;
}

type PendingProcessEvent<T extends SupervisedProcessEvent = SupervisedProcessEvent> = T extends SupervisedProcessEvent
  ? Omit<T, 'executionId' | 'sequence' | 'observedAt'>
  : never;

const isoNow = (): string => new Date().toISOString();
const errorDetail = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

const withTimeout = async <T>(promise: Promise<T>, milliseconds: number, detail: string): Promise<T> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(detail)), milliseconds);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
};

export class WindowsProcessSupervisor implements ProcessSupervisor {
  readonly #records = new Map<string, OwnedProcessRecord>();

  async start(spec: SupervisedProcessSpec): Promise<SupervisedProcessSnapshot> {
    if (this.#records.has(spec.executionId)) {
      throw new Error(`Execution ID is already supervised: ${spec.executionId}`);
    }

    let resolveCompletion: ((result: SupervisedProcessResult) => void) | undefined;
    const completion = new Promise<SupervisedProcessResult>((resolve) => {
      resolveCompletion = resolve;
    });
    const child = spawn(spec.executablePath, [...spec.arguments], {
      cwd: spec.workingDirectory,
      env: { ...process.env, ...spec.environment },
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const record: OwnedProcessRecord = {
      child,
      snapshot: {
        executionId: spec.executionId,
        processId: null,
        state: 'starting',
        startedAt: null,
        lastOutputAt: null,
        finishedAt: null,
        cancellationRequested: false,
        exitCode: null,
        failureReason: null,
      },
      events: [],
      listeners: new Set(),
      stdout: [],
      stderr: [],
      completion,
      cancellation: null,
      resolveCompletion: resolveCompletion!,
      sequence: 0,
      signal: null,
      settled: false,
    };
    this.#records.set(spec.executionId, record);

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.#recordOutput(record, 'stdout', chunk));
    child.stderr?.on('data', (chunk: string) => this.#recordOutput(record, 'stderr', chunk));

    const spawned = new Promise<SupervisedProcessSnapshot>((resolve, reject) => {
      child.once('spawn', () => {
        const processId = child.pid;
        if (processId === undefined) {
          const detail = 'The child process started without a process ID.';
          this.#failBeforeStart(record, detail);
          reject(new Error(detail));
          return;
        }

        record.snapshot.processId = processId;
        record.snapshot.state = 'running';
        record.snapshot.startedAt = isoNow();
        this.#emit(record, { type: 'started', processId });
        resolve(this.#copySnapshot(record.snapshot));
      });

      child.once('error', (error) => {
        const detail = errorDetail(error);
        record.snapshot.failureReason = detail;
        this.#emit(record, { type: 'failure', detail });
        if (record.snapshot.startedAt === null) {
          this.#failBeforeStart(record, detail);
          reject(error);
        }
      });
    });

    child.once('close', (exitCode, signal) => {
      record.signal = signal;
      record.snapshot.exitCode = exitCode;
      record.snapshot.finishedAt = isoNow();
      record.snapshot.state = record.snapshot.startedAt === null && record.snapshot.failureReason ? 'failed' : 'exited';
      this.#emit(record, { type: 'exit', exitCode, signal });
      this.#settle(record);
    });

    return spawned;
  }

  snapshot(executionId: string): SupervisedProcessSnapshot | undefined {
    const record = this.#records.get(executionId);
    return record ? this.#copySnapshot(record.snapshot) : undefined;
  }

  subscribe(executionId: string, listener: SupervisedProcessEventListener, replay = true): () => void {
    const record = this.#requiredRecord(executionId);
    if (replay) {
      for (const event of record.events) {
        listener(event);
      }
    }
    record.listeners.add(listener);
    return () => record.listeners.delete(listener);
  }

  waitForCompletion(executionId: string): Promise<SupervisedProcessResult> {
    const record = this.#records.get(executionId);
    return record
      ? record.completion
      : Promise.reject(new Error(`Execution is not owned by this supervisor: ${executionId}`));
  }

  async cancelOwnedTree(executionId: string): Promise<void> {
    const record = this.#requiredRecord(executionId);
    if (record.settled || record.snapshot.state === 'exited' || record.snapshot.state === 'failed') {
      return;
    }
    if (record.snapshot.processId === null) {
      throw new Error(`Cannot cancel execution before it has a process ID: ${executionId}`);
    }

    if (!record.snapshot.cancellationRequested) {
      record.snapshot.cancellationRequested = true;
      record.snapshot.state = 'cancelling';
      this.#emit(record, { type: 'cancellation_requested' });
    }

    if (!record.cancellation) {
      record.cancellation = process.platform === 'win32' ? this.#cancelWindowsTree(record) : this.#cancelPortableTree(record);
    }
    await record.cancellation;
  }

  async #cancelWindowsTree(record: OwnedProcessRecord): Promise<void> {
    const processId = record.snapshot.processId;
    if (processId === null || record.settled) {
      return;
    }

    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
    const taskkillPath = join(systemRoot, 'System32', 'taskkill.exe');
    const taskkill = spawn(taskkillPath, ['/PID', String(processId), '/T', '/F'], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    });
    const taskkillCompletion = new Promise<number | null>((resolve, reject) => {
      taskkill.once('error', reject);
      taskkill.once('close', resolve);
    });

    let taskkillExitCode: number | null;
    try {
      taskkillExitCode = await withTimeout(taskkillCompletion, KILL_TIMEOUT_MS, 'Timed out while terminating the process tree.');
    } catch (error) {
      taskkill.kill();
      if (!record.settled) {
        throw error;
      }
      return;
    }

    if (taskkillExitCode !== 0 && !record.settled) {
      throw new Error(`taskkill failed for owned process ${processId} with exit code ${String(taskkillExitCode)}.`);
    }
    await withTimeout(record.completion, KILL_TIMEOUT_MS, `Owned process ${processId} did not exit after cancellation.`);
  }

  async #cancelPortableTree(record: OwnedProcessRecord): Promise<void> {
    const processId = record.snapshot.processId;
    if (processId === null || record.settled) {
      return;
    }

    this.#killPortableGroup(processId, 'SIGTERM', record.child);
    await Promise.race([record.completion.then(() => undefined), wait(NON_WINDOWS_GRACE_MS)]);
    if (!record.settled) {
      this.#killPortableGroup(processId, 'SIGKILL', record.child);
    }
    await withTimeout(record.completion, KILL_TIMEOUT_MS, `Owned process ${processId} did not exit after cancellation.`);
  }

  #killPortableGroup(processId: number, signal: NodeJS.Signals, child: ChildProcess): void {
    try {
      process.kill(-processId, signal);
    } catch {
      child.kill(signal);
    }
  }

  #requiredRecord(executionId: string): OwnedProcessRecord {
    const record = this.#records.get(executionId);
    if (!record) {
      throw new Error(`Execution is not owned by this supervisor: ${executionId}`);
    }
    return record;
  }

  #recordOutput(record: OwnedProcessRecord, stream: 'stdout' | 'stderr', chunk: string): void {
    record[stream].push(chunk);
    record.snapshot.lastOutputAt = isoNow();
    this.#emit(record, { type: 'output', stream, chunk });
  }

  #failBeforeStart(record: OwnedProcessRecord, detail: string): void {
    record.snapshot.state = 'failed';
    record.snapshot.failureReason = detail;
    record.snapshot.finishedAt = isoNow();
    this.#settle(record);
  }

  #settle(record: OwnedProcessRecord): void {
    if (record.settled) {
      return;
    }
    record.settled = true;
    record.resolveCompletion({
      ...this.#copySnapshot(record.snapshot),
      signal: record.signal,
      stdout: record.stdout.join(''),
      stderr: record.stderr.join(''),
    });
  }

  #emit(record: OwnedProcessRecord, event: PendingProcessEvent): void {
    const completeEvent = {
      ...event,
      executionId: record.snapshot.executionId,
      sequence: record.sequence++,
      observedAt: isoNow(),
    };
    record.events.push(completeEvent);
    for (const listener of record.listeners) {
      listener(completeEvent);
    }
  }

  #copySnapshot(snapshot: SupervisedProcessSnapshot): SupervisedProcessSnapshot {
    return { ...snapshot };
  }
}
