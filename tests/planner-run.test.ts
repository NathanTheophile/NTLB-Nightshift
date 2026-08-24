import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { DatabaseService } from '../src/main/persistence/DatabaseService';
import { PlannerTaskRepository } from '../src/main/persistence/repositories/PlannerTaskRepository';
import { RunRepository } from '../src/main/persistence/repositories/RunRepository';
import { WorkspaceRepository } from '../src/main/persistence/repositories/WorkspaceRepository';
import { GitWorktreeService } from '../src/main/services/GitWorktreeService';
import { RunService } from '../src/main/services/RunService';
import type { AgentAdapter, AgentExecutionHandle, AgentExecutionResult, RunStartSpec } from '../src/main/services/contracts/AgentAdapter';
import type { AgentCapabilities, AgentDescriptor, Run } from '../src/shared/domain/entities';

const exec = promisify(execFile);
const capabilities: AgentCapabilities = { interactive: false, headless: true, structuredEvents: true, rawPty: false, resume: false, modelOverride: true, cancel: true, workingDirectory: true, imageInput: false, subagents: false, plannerValidated: true, workerValidated: false, renderMode: 'structured' };

describe('Planner Run vertical slice', () => {
  it('runs in a Git worktree, preserves the source tree, and persists structured evidence', async () => {
    const fixture = await setup();
    try {
      const adapter = new CompletingAdapter();
      const service = fixture.service(adapter, 1_000);
      const task = fixture.tasks.create({ workspaceId: fixture.workspace.id, prompt: 'Create marker.', requestedAgentId: null, requestedModelId: null, priority: 1 });
      service.schedule();
      const run = await waitFor<Run | undefined>(() => service.list(fixture.workspace.id)[0]);
      await waitFor(() => service.find(run.id).then((value) => value?.status === 'completed' ? value : undefined));
      const completed = (await service.find(run.id))!;
      expect(await readFile(join(fixture.repository, 'marker.txt'), 'utf8')).toBe('base\n');
      expect(await readFile(join(completed.worktreePath!, 'marker.txt'), 'utf8')).toBe('changed by planner\n');
      expect(completed.status).toBe('completed'); expect(completed.baseSha).toBeTruthy(); expect(completed.finalHeadSha).toBeTruthy(); expect(completed.externalSessionId).toBe('session-test');
      expect(completed.finalGitState).toContain('marker.txt');
      expect(service.events(completed.id).map((event) => event.eventType)).toContain('claude_protocol');
      expect(fixture.tasks.findById(task.id)?.status).toBe('completed');
    } finally { await fixture.dispose(); }
  });

  it('times out, cancels the owned adapter, and continues to the next queued task', async () => {
    const fixture = await setup();
    try {
      const adapter = new TimeoutThenCompleteAdapter();
      const service = fixture.service(adapter, 20);
      fixture.tasks.create({ workspaceId: fixture.workspace.id, prompt: 'First.', requestedAgentId: null, requestedModelId: null, priority: 1 });
      fixture.tasks.create({ workspaceId: fixture.workspace.id, prompt: 'Second.', requestedAgentId: null, requestedModelId: null, priority: 2 });
      service.schedule();
      await waitFor(() => service.list(fixture.workspace.id).some((run) => run.status === 'timed_out') ? true : undefined, 2_000);
      await waitFor(() => service.list(fixture.workspace.id).some((run) => run.status === 'completed') ? true : undefined, 2_000);
      expect(adapter.cancelled).toBeGreaterThan(0);
    } finally { await fixture.dispose(); }
  });

  it('turns a user cancellation request into a deterministic cancelled Run', async () => {
    const fixture = await setup();
    try {
      const adapter = new TimeoutThenCompleteAdapter(); const service = fixture.service(adapter, 5_000);
      fixture.tasks.create({ workspaceId: fixture.workspace.id, prompt: 'Cancel me.', requestedAgentId: null, requestedModelId: null, priority: 1 }); service.schedule();
      const running = await waitFor<Run | undefined>(() => service.list(fixture.workspace.id).find((run) => run.status === 'running'));
      await service.requestCancellation(running.id);
      const cancelled = await waitFor(() => service.find(running.id).then((run) => run?.status === 'cancelled' ? run : undefined));
      expect(cancelled.status).toBe('cancelled'); expect(adapter.cancelled).toBe(1);
    } finally { await fixture.dispose(); }
  });
});

const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), 'nightshift-planner-'));
  const repository = join(root, 'repository'); const worktrees = join(root, 'worktrees');
  await exec('git', ['init', repository]); await exec('git', ['-C', repository, 'config', 'user.email', 'test@nightshift.local']); await exec('git', ['-C', repository, 'config', 'user.name', 'NightShift Test']);
  await writeFile(join(repository, 'marker.txt'), 'base\n'); await exec('git', ['-C', repository, 'add', '.']); await exec('git', ['-C', repository, 'commit', '-m', 'base']);
  const database = new DatabaseService(':memory:'); const workspaces = new WorkspaceRepository(database); const tasks = new PlannerTaskRepository(database); const runs = new RunRepository(database); const workspace = workspaces.addOrTouch(repository, 'repository', true);
  return { repository, workspace, tasks, service: (adapter: AgentAdapter, timeoutMs: number) => new RunService(runs, tasks, workspaces, new GitWorktreeService(worktrees), new Map([[adapter.id, adapter]]), { agentId: adapter.id, modelId: 'nvidia_nim/nvidia/nemotron-3-super-120b-a12b', timeoutMs }), dispose: async () => { database.close(); await rm(root, { recursive: true, force: true }); } };
};

class CompletingAdapter implements AgentAdapter {
  public readonly id = 'claude-code'; public capabilities = (): AgentCapabilities => capabilities; public detect = (): Promise<AgentDescriptor> => Promise.resolve({ id: this.id, displayName: 'Test', fccLauncher: 'test', installed: true, launchable: true, version: null, capabilities, lastValidatedAt: null });
  public async startRun(spec: RunStartSpec): Promise<AgentExecutionHandle> { const event = { sequence: 0, timestamp: new Date().toISOString(), raw: '{"type":"system"}', parsed: { type: 'system' }, type: 'system', externalSessionId: 'session-test', terminal: false, parseError: null }; spec.onProtocolEvent?.(event); await writeFile(join(spec.workingDirectory, 'marker.txt'), 'changed by planner\n'); return { handleId: randomUUID(), externalSessionId: 'session-test', events: [event], completion: Promise.resolve({ handleId: 'complete', succeeded: true, failureReason: null, exitCode: 0, signal: null, externalSessionId: 'session-test', events: [event], terminalEvent: { ...event, terminal: true }, stderr: '' }) }; }
  public startWorker(): Promise<AgentExecutionHandle> { return Promise.reject(new Error('not implemented')); } public cancel(): Promise<void> { return Promise.resolve(); }
}
class TimeoutThenCompleteAdapter extends CompletingAdapter {
  public cancelled = 0; private launches = 0; private resolve?: (value: AgentExecutionResult) => void;
  public override async startRun(spec: RunStartSpec): Promise<AgentExecutionHandle> { this.launches += 1; if (this.launches > 1) return super.startRun(spec); const handleId = randomUUID(); let resolveCompletion!: (result: AgentExecutionResult) => void; const completion = new Promise<AgentExecutionResult>((resolve) => { resolveCompletion = resolve; }); this.resolve = resolveCompletion; return { handleId, externalSessionId: null, events: [], completion }; }
  public override cancel(): Promise<void> { this.cancelled += 1; this.resolve?.({ handleId: 'timeout', succeeded: false, failureReason: 'cancelled', exitCode: null, signal: 'SIGTERM', externalSessionId: null, events: [], terminalEvent: null, stderr: '' }); return Promise.resolve(); }
}
const waitFor = async <T>(get: () => T | Promise<T>, timeoutMs = 1_000): Promise<NonNullable<T>> => { const until = Date.now() + timeoutMs; for (;;) { const value = await get(); if (value) return value; if (Date.now() >= until) throw new Error('Condition timed out.'); await new Promise((resolve) => setTimeout(resolve, 10)); } };
