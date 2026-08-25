import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { WindowsProcessSupervisor } from '../src/main/services/WindowsProcessSupervisor';
import { ClaudeCodeAdapter } from '../src/main/services/agents/ClaudeCodeAdapter';
import { FccRuntimeManager } from '../src/main/services/runtime/FccRuntimeManager';
import { LocalFccGateway } from '../src/main/services/runtime/LocalFccGateway';

const execFileAsync = promisify(execFile);
const probeEnabled = process.env.NIGHTSHIFT_RUN_FCC_PROBE === '1';
const probeTimeoutMs = 180_000;

describe.skipIf(!probeEnabled)('ClaudeCodeAdapter real FCC integration', () => {
  it('uses structured Worker events and resumes the same Claude session', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'nightshift-worker-probe-'));
    const supervisor = new WindowsProcessSupervisor(); const gateway = new LocalFccGateway(new FccRuntimeManager({ supervisor })); const adapter = new ClaudeCodeAdapter(supervisor, gateway);
    try {
      const first = await adapter.startWorker({ workerId: 'real-worker-probe', workspaceId: 'scratch-worker-probe', workingDirectory, modelId: 'nvidia_nim/nvidia/nemotron-3-super-120b-a12b', permissionProfile: 'read_only', isolationMode: 'direct_workspace', prompt: 'Reply with exactly NIGHTSHIFT_WORKER_PROBE_OK. Do not modify files.', externalSessionId: null });
      const firstResult = await completionWithin(adapter, first.handleId, first.completion);
      expect(firstResult).toMatchObject({ succeeded: true, exitCode: 0 }); expect(firstResult.externalSessionId).toBeTruthy(); expect(firstResult.events.some(({ type }) => type === 'assistant')).toBe(true);
      const resumed = await adapter.startWorker({ workerId: 'real-worker-probe', workspaceId: 'scratch-worker-probe', workingDirectory, modelId: 'nvidia_nim/nvidia/nemotron-3-super-120b-a12b', permissionProfile: 'read_only', isolationMode: 'direct_workspace', prompt: 'Reply with exactly NIGHTSHIFT_WORKER_RESUME_OK. Do not modify files.', externalSessionId: firstResult.externalSessionId });
      const resumedResult = await completionWithin(adapter, resumed.handleId, resumed.completion);
      expect(resumedResult).toMatchObject({ succeeded: true, exitCode: 0, externalSessionId: firstResult.externalSessionId });
    } finally { await gateway.stopOwnedProcess(); await rm(workingDirectory, { recursive: true, force: true }); }
  }, probeTimeoutMs * 2 + 30_000);

  it('creates the bounded runtime marker in an isolated Git workspace', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'nightshift-runtime-probe-'));
    const supervisor = new WindowsProcessSupervisor();
    const gateway = new LocalFccGateway(new FccRuntimeManager({ supervisor }));
    const adapter = new ClaudeCodeAdapter(supervisor, gateway);

    try {
      await execFileAsync('git', ['init'], { cwd: workingDirectory, windowsHide: true });
      const health = await gateway.ensureAvailable();
      expect(health).toMatchObject({ available: true, version: '5.14.2' });

      const handle = await adapter.startRun({
        runId: 'real-runtime-probe',
        workspaceId: 'scratch-runtime-probe',
        workingDirectory,
        modelId: 'nvidia_nim/nvidia/nemotron-3-super-120b-a12b',
        prompt: 'Create NIGHTSHIFT_RUNTIME_PROBE.txt in the repository root with the complete file contents exactly NIGHTSHIFT_RUNTIME_OK and no trailing newline. Do not modify any other file.',
      });
      const result = await completionWithin(adapter, handle.handleId, handle.completion);

      expect(result).toMatchObject({ succeeded: true, exitCode: 0 });
      expect(result.externalSessionId).toBeTruthy();
      expect(result.terminalEvent?.type).toBe('result');
      expect(await readFile(join(workingDirectory, 'NIGHTSHIFT_RUNTIME_PROBE.txt'), 'utf8'))
        .toBe('NIGHTSHIFT_RUNTIME_OK');

      const { stdout: status } = await execFileAsync('git', ['status', '--short'], {
        cwd: workingDirectory,
        windowsHide: true,
      });
      expect(status.trim()).toBe('?? NIGHTSHIFT_RUNTIME_PROBE.txt');
    } finally {
      await gateway.stopOwnedProcess();
      await rm(workingDirectory, { recursive: true, force: true });
    }
  }, probeTimeoutMs + 30_000);
});

const completionWithin = async <T>(
  adapter: ClaudeCodeAdapter,
  handleId: string,
  completion: Promise<T>,
): Promise<T> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      completion,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          void adapter.cancel(handleId).finally(() => reject(new Error(`Claude probe timed out after ${probeTimeoutMs}ms.`)));
        }, probeTimeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};
