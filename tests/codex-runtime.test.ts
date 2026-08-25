import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { FccGateway } from '../src/main/services/contracts/FccGateway';
import type { ProcessSupervisor, SupervisedProcessEventListener, SupervisedProcessResult, SupervisedProcessSnapshot, SupervisedProcessSpec } from '../src/main/services/contracts/ProcessSupervisor';
import { CodexAdapter } from '../src/main/services/agents/CodexAdapter';
import { buildCodexRunArguments } from '../src/main/services/agents/codex/codexCommand';
import { CodexJsonlParser } from '../src/main/services/agents/codex/CodexJsonlParser';

const model = 'nvidia_nim/nvidia/nemotron-3-super-120b-a12b';

describe('CodexAdapter runtime protocol', () => {
  it('constructs the validated explicit FCC headless command', () => {
    expect(buildCodexRunArguments({ runId: 'run', workspaceId: 'workspace', workingDirectory: 'C:\\scratch\\probe', modelId: model, prompt: 'Create marker.' })).toEqual([
      'exec', '-C', 'C:\\scratch\\probe', '-m', model, '-s', 'workspace-write', '--json', 'Create marker.',
    ]);
  });

  it('preserves JSONL event types and extracts nested thread_id', () => {
    const parser = new CodexJsonlParser();
    const events = [...parser.push('{"type":"thread.started","thread_id":"thread-123"}\n{"type":"item.started","item":{"type":"command_execution"}}\n'), ...parser.push('{"type":"turn.completed","data":{"thread_id":"thread-123"}}\nnot-json\n')];
    expect(events.map(({ type }) => type)).toEqual(['thread.started', 'item.started', 'turn.completed', null]);
    expect(events[2]).toMatchObject({ terminal: true, threadId: 'thread-123' });
    expect(parser.threadId).toBe('thread-123');
    expect(parser.terminalEvent?.type).toBe('turn.completed');
  });

  it('completes despite a stderr router warning and wires cancellation to the supervisor', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'nightshift-codex-unit-'));
    try {
      const supervisor = new ScriptedSupervisor([
        '{"type":"thread.started","thread_id":"thread-unit"}\n',
        '{"type":"agent_message","thread_id":"thread-unit"}\n{"type":"turn.completed","thread_id":"thread-unit"}\n',
      ], 'router warning: retry policy unavailable');
      const adapter = new CodexAdapter(supervisor, healthyGateway(), { discoverLauncher: () => Promise.resolve('C:\\tools\\fcc-codex.exe'), createExecutionId: () => 'codex-run-unit' });
      const handle = await adapter.startRun({ runId: 'run-unit', workspaceId: 'workspace-unit', workingDirectory, modelId: model, prompt: 'Edit one file.' });
      const result = await handle.completion;
      expect(supervisor.startedSpec?.arguments).toEqual(buildCodexRunArguments({ runId: 'run-unit', workspaceId: 'workspace-unit', workingDirectory, modelId: model, prompt: 'Edit one file.' }));
      expect(result).toMatchObject({ succeeded: true, exitCode: 0, externalSessionId: 'thread-unit', stderr: 'router warning: retry policy unavailable' });
      await adapter.cancel(handle.handleId);
      expect(supervisor.cancelledExecutionId).toBe('codex-run-unit');
    } finally { await rm(workingDirectory, { recursive: true, force: true }); }
  });
});

class ScriptedSupervisor implements ProcessSupervisor {
  public startedSpec: SupervisedProcessSpec | null = null;
  public cancelledExecutionId: string | null = null;
  public constructor(private readonly chunks: readonly string[], private readonly stderr: string) {}
  public start(spec: SupervisedProcessSpec): Promise<SupervisedProcessSnapshot> { this.startedSpec = spec; return Promise.resolve(snapshot(spec.executionId)); }
  public snapshot(executionId: string): SupervisedProcessSnapshot | undefined { return this.startedSpec?.executionId === executionId ? snapshot(executionId) : undefined; }
  public subscribe(executionId: string, listener: SupervisedProcessEventListener): () => void { this.chunks.forEach((chunk, sequence) => listener({ type: 'output', executionId, sequence, observedAt: '2026-08-25T00:00:00.000Z', stream: 'stdout', chunk })); return () => undefined; }
  public waitForCompletion(executionId: string): Promise<SupervisedProcessResult> { return Promise.resolve({ ...snapshot(executionId), state: 'exited', finishedAt: '2026-08-25T00:00:01.000Z', exitCode: 0, signal: null, stdout: this.chunks.join(''), stderr: this.stderr }); }
  public cancelOwnedTree(executionId: string): Promise<void> { this.cancelledExecutionId = executionId; return Promise.resolve(); }
}

const snapshot = (executionId: string): SupervisedProcessSnapshot => ({ executionId, processId: 42, state: 'running', startedAt: '2026-08-25T00:00:00.000Z', lastOutputAt: null, finishedAt: null, cancellationRequested: false, exitCode: null, failureReason: null });
const healthyGateway = (): FccGateway => ({ detect: () => Promise.resolve(health), ensureAvailable: () => Promise.resolve(health), health: () => Promise.resolve(health), listModels: () => Promise.resolve([]), stopOwnedProcess: () => Promise.resolve() });
const health = { state: 'healthy' as const, available: true, endpoint: 'http://127.0.0.1:8082', version: '5.14.2', ownedByNightShift: false, detail: 'healthy', failureReason: null };
