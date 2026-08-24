import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { SupervisedProcessEvent } from '../src/main/services/contracts/ProcessSupervisor';
import { WindowsProcessSupervisor } from '../src/main/services/WindowsProcessSupervisor';

const fixturePath = resolve('tests/fixtures/supervised-child.js');

const isProcessAlive = (processId: number): boolean => {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
};

const waitUntil = async (predicate: () => boolean, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for the process condition.');
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
};

describe('WindowsProcessSupervisor', () => {
  it('captures stdout, stderr, exit state, and replayable ordered events', async () => {
    expect(existsSync(fixturePath)).toBe(true);
    const supervisor = new WindowsProcessSupervisor();
    const started = await supervisor.start({
      executionId: 'normal-completion',
      executablePath: process.execPath,
      arguments: [fixturePath, 'complete'],
      workingDirectory: dirname(fixturePath),
      environment: {},
    });

    expect(started.state).toBe('running');
    expect(started.processId).toBeTypeOf('number');
    const result = await supervisor.waitForCompletion('normal-completion');
    expect(result).toMatchObject({
      state: 'exited',
      exitCode: 7,
      stdout: 'fixture-stdout',
      stderr: 'fixture-stderr',
      cancellationRequested: false,
    });

    const replayed: SupervisedProcessEvent[] = [];
    supervisor.subscribe('normal-completion', (event) => replayed.push(event));
    expect(replayed[0]?.type).toBe('started');
    expect(replayed.at(-1)?.type).toBe('exit');
    expect(replayed.filter(({ type }) => type === 'output')).toHaveLength(2);
    expect(replayed.map(({ sequence }) => sequence)).toEqual([0, 1, 2, 3]);
    expect(await supervisor.waitForCompletion('normal-completion')).toEqual(result);
  });

  it('rejects unknown and duplicate execution IDs', async () => {
    const supervisor = new WindowsProcessSupervisor();
    await expect(supervisor.waitForCompletion('not-owned')).rejects.toThrow('not owned');
    await supervisor.start({
      executionId: 'duplicate',
      executablePath: process.execPath,
      arguments: [fixturePath, 'complete'],
      workingDirectory: dirname(fixturePath),
      environment: {},
    });
    await expect(
      supervisor.start({
        executionId: 'duplicate',
        executablePath: process.execPath,
        arguments: [fixturePath, 'complete'],
        workingDirectory: dirname(fixturePath),
        environment: {},
      }),
    ).rejects.toThrow('already supervised');
    await supervisor.waitForCompletion('duplicate');
  });

  it.runIf(process.platform === 'win32')(
    'cancels the complete Windows tree for an owned process',
    async () => {
      const supervisor = new WindowsProcessSupervisor();
      await supervisor.start({
        executionId: 'tree-cancellation',
        executablePath: process.execPath,
        arguments: [fixturePath, 'tree-parent'],
        workingDirectory: dirname(fixturePath),
        environment: {},
      });

      let output = '';
      supervisor.subscribe('tree-cancellation', (event) => {
        if (event.type === 'output' && event.stream === 'stdout') {
          output += event.chunk;
        }
      });
      await waitUntil(() => /^\d+\s*$/.test(output), 2_000);
      const descendantProcessId = Number.parseInt(output, 10);
      expect(isProcessAlive(descendantProcessId)).toBe(true);

      await Promise.all([
        supervisor.cancelOwnedTree('tree-cancellation'),
        supervisor.cancelOwnedTree('tree-cancellation'),
      ]);
      const result = await supervisor.waitForCompletion('tree-cancellation');
      expect(result.cancellationRequested).toBe(true);
      expect(result.state).toBe('exited');
      await waitUntil(() => !isProcessAlive(descendantProcessId), 2_000);
    },
    15_000,
  );
});
