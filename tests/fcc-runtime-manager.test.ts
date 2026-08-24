import { describe, expect, it, vi } from 'vitest';

import type {
  ProcessSupervisor,
  SupervisedProcessResult,
  SupervisedProcessSnapshot,
} from '../src/main/services/contracts/ProcessSupervisor';
import {
  FccRuntimeManager,
  type FccEndpointProbeResult,
  type FccRuntimeProbe,
} from '../src/main/services/runtime/FccRuntimeManager';

const available = (version = '5.14.2'): FccEndpointProbeResult => ({
  available: true,
  version,
  detail: 'healthy',
  failureReason: null,
});

const unavailable = (): FccEndpointProbeResult => ({
  available: false,
  version: null,
  detail: 'offline',
  failureReason: 'offline',
});

class SequenceProbe implements FccRuntimeProbe {
  public readonly probe = vi.fn<FccRuntimeProbe['probe']>(() =>
    Promise.resolve(this.results.shift() ?? this.fallback));

  public constructor(
    private readonly results: FccEndpointProbeResult[],
    private readonly fallback = unavailable(),
  ) {}
}

class FakeSupervisor implements ProcessSupervisor {
  public readonly start = vi.fn<ProcessSupervisor['start']>((spec) => {
    const snapshot = processSnapshot(spec.executionId);
    this.processes.set(spec.executionId, snapshot);
    return Promise.resolve(snapshot);
  });
  public readonly cancelOwnedTree = vi.fn<ProcessSupervisor['cancelOwnedTree']>((executionId) => {
    const snapshot = this.processes.get(executionId);
    if (snapshot) {
      snapshot.cancellationRequested = true;
      snapshot.state = 'exited';
      snapshot.exitCode = 1;
      snapshot.finishedAt = '2026-08-25T00:00:01.000Z';
    }
    return Promise.resolve();
  });
  public readonly processes = new Map<string, SupervisedProcessSnapshot>();

  public snapshot(executionId: string): SupervisedProcessSnapshot | undefined {
    return this.processes.get(executionId);
  }

  public subscribe(): () => void {
    return () => undefined;
  }

  public waitForCompletion(executionId: string): Promise<SupervisedProcessResult> {
    const snapshot = this.processes.get(executionId);
    if (!snapshot) {
      return Promise.reject(new Error('Unknown process.'));
    }
    return Promise.resolve({ ...snapshot, signal: null, stdout: '', stderr: '' });
  }
}

describe('FccRuntimeManager', () => {
  it('attaches to an existing server without starting or stopping it', async () => {
    const supervisor = new FakeSupervisor();
    const manager = managerWith(supervisor, new SequenceProbe([available()]));

    const health = await manager.ensureAvailable();
    await manager.stopOwnedProcess();

    expect(health).toMatchObject({ available: true, ownedByNightShift: false, version: '5.14.2' });
    expect(supervisor.start).not.toHaveBeenCalled();
    expect(supervisor.cancelOwnedTree).not.toHaveBeenCalled();
  });

  it('coalesces concurrent startup and owns the process that becomes ready', async () => {
    const supervisor = new FakeSupervisor();
    const gate = deferred<FccEndpointProbeResult>();
    const probe: FccRuntimeProbe = {
      probe: vi.fn()
        .mockResolvedValueOnce(unavailable())
        .mockResolvedValueOnce(unavailable())
        .mockImplementationOnce(() => gate.promise),
    };
    const manager = managerWith(supervisor, probe);

    const first = manager.ensureAvailable();
    const second = manager.ensureAvailable();
    await vi.waitFor(() => expect(supervisor.start).toHaveBeenCalledOnce());
    gate.resolve(available());

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ available: true, ownedByNightShift: true }),
      expect.objectContaining({ available: true, ownedByNightShift: true }),
    ]);
    expect(supervisor.start).toHaveBeenCalledOnce();
  });

  it('does not claim ownership when an external process wins the startup race', async () => {
    const supervisor = new FakeSupervisor();
    supervisor.start.mockImplementationOnce((spec) => {
      const snapshot = processSnapshot(spec.executionId);
      snapshot.state = 'exited';
      snapshot.exitCode = 1;
      snapshot.finishedAt = '2026-08-25T00:00:01.000Z';
      supervisor.processes.set(spec.executionId, snapshot);
      return Promise.resolve(snapshot);
    });
    const manager = managerWith(supervisor, new SequenceProbe([unavailable(), unavailable(), available()]));

    const health = await manager.ensureAvailable();

    expect(health).toMatchObject({ available: true, ownedByNightShift: false });
    await manager.stopOwnedProcess();
    expect(supervisor.cancelOwnedTree).not.toHaveBeenCalled();
  });

  it('cancels only its owned startup process when readiness times out', async () => {
    const supervisor = new FakeSupervisor();
    let now = 0;
    const manager = managerWith(supervisor, new SequenceProbe([], unavailable()), {
      startupTimeoutMs: 10,
      pollIntervalMs: 5,
      now: () => now,
      delay: (milliseconds) => {
        now += milliseconds;
        return Promise.resolve();
      },
    });

    const health = await manager.ensureAvailable();

    expect(health).toMatchObject({ state: 'failed', available: false, ownedByNightShift: false });
    expect(supervisor.cancelOwnedTree).toHaveBeenCalledOnce();
    expect(supervisor.cancelOwnedTree).toHaveBeenCalledWith('fcc-test');
  });

  it('retains ownership and refuses a duplicate when startup cancellation fails', async () => {
    const supervisor = new FakeSupervisor();
    supervisor.cancelOwnedTree.mockRejectedValueOnce(new Error('taskkill failed'));
    let now = 0;
    const manager = managerWith(supervisor, new SequenceProbe([], unavailable()), {
      startupTimeoutMs: 10,
      pollIntervalMs: 5,
      now: () => now,
      delay: (milliseconds) => {
        now += milliseconds;
        return Promise.resolve();
      },
    });

    const timedOut = await manager.ensureAvailable();
    const retried = await manager.ensureAvailable();

    expect(timedOut).toMatchObject({ state: 'failed', ownedByNightShift: true });
    expect(retried).toMatchObject({ state: 'failed', ownedByNightShift: true });
    expect(supervisor.start).toHaveBeenCalledOnce();
  });

  it('stops an owned healthy server and only that execution', async () => {
    const supervisor = new FakeSupervisor();
    const manager = managerWith(supervisor, new SequenceProbe([unavailable(), unavailable(), available()]));
    await manager.ensureAvailable();

    await manager.stopOwnedProcess();
    await manager.stopOwnedProcess();

    expect(supervisor.cancelOwnedTree).toHaveBeenCalledOnce();
    expect(supervisor.cancelOwnedTree).toHaveBeenCalledWith('fcc-test');
  });
});

const managerWith = (
  supervisor: ProcessSupervisor,
  probe: FccRuntimeProbe,
  overrides: Partial<ConstructorParameters<typeof FccRuntimeManager>[0]> = {},
): FccRuntimeManager => new FccRuntimeManager({
  supervisor,
  probe,
  endpoint: 'http://127.0.0.1:8082',
  environment: { PATH: 'C:\\tools' },
  discoverServer: () => Promise.resolve('C:\\tools\\fcc-server.exe'),
  probeVersion: () => Promise.resolve('5.14.2'),
  createExecutionId: () => 'fcc-test',
  ...overrides,
});

const processSnapshot = (executionId: string): SupervisedProcessSnapshot => ({
  executionId,
  processId: 42,
  state: 'running',
  startedAt: '2026-08-25T00:00:00.000Z',
  lastOutputAt: null,
  finishedAt: null,
  cancellationRequested: false,
  exitCode: null,
  failureReason: null,
});

const deferred = <Value>() => {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((promiseResolve) => { resolve = promiseResolve; });
  return { promise, resolve };
};
