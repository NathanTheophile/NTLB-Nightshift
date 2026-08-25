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
import type { WorktreeHandle, WorktreeService, WorktreeSpec } from '../src/main/services/contracts/WorktreeService';
import type { AgentCapabilities, AgentDescriptor, Run } from '../src/shared/domain/entities';

const exec = promisify(execFile);
const capabilities: AgentCapabilities = { interactive: false, headless: true, structuredEvents: true, rawPty: false, resume: false, modelOverride: true, cancel: true, workingDirectory: true, imageInput: false, subagents: false, plannerValidated: true, workerValidated: false, renderMode: 'structured' };

describe('Planner Run vertical slice', () => {
  it('persists the supplied base SHA when creating an attempt', async () => {
    const fixture = await setup();
    try {
      const task = fixture.tasks.create({ workspaceId: fixture.workspace.id, prompt: 'Persist base.', requestedAgentId: null, requestedModelId: null, priority: 1 });
      const run = await fixture.service(new CompletingAdapter(), 1_000).createAttempt({ taskId: task.id, workspaceId: task.workspaceId, resolvedAgentId: 'claude-code', resolvedModelId: 'model', baseSha: 'abc123' });
      expect(run.baseSha).toBe('abc123');
    } finally { await fixture.dispose(); }
  });

  it('persists an explicit Codex and model selection on the Task', async () => {
    const fixture = await setup();
    try {
      const task = fixture.tasks.create({ workspaceId: fixture.workspace.id, prompt: 'Use Codex.', requestedAgentId: 'codex', requestedModelId: 'nvidia_nim/nvidia/nemotron-3-super-120b-a12b', priority: 1 });
      expect(task).toMatchObject({ requestedAgentId: 'codex', requestedModelId: 'nvidia_nim/nvidia/nemotron-3-super-120b-a12b' });
    } finally { await fixture.dispose(); }
  });

  it('runs ordered batch steps as fresh invocations in one worktree', async () => {
    const fixture = await setup();
    try {
      const adapter = new CompletingAdapter(); const service = fixture.service(adapter, 1_000);
      const task = fixture.tasks.create({ workspaceId: fixture.workspace.id, prompt: 'Shared context.', requestedAgentId: null, requestedModelId: null, priority: 1, executionMode: 'sequential_batch', batchSteps: ['Create the marker.', 'Inspect the marker.'] });
      service.schedule();
      const run = await waitFor<Run | undefined>(() => service.list(fixture.workspace.id)[0]);
      const completed = await waitFor(() => service.find(run.id).then((value) => value?.status === 'completed' ? value : undefined));
      const steps = service.batchSteps(run.id);
      expect(run.executionMode).toBe('sequential_batch'); expect(adapter.starts).toBe(2); expect(new Set(adapter.workingDirectories)).toEqual(new Set([completed.worktreePath]));
      expect(steps.map((step) => step.status)).toEqual(['completed', 'completed']);
      expect(service.events(run.id, 'activity').events.map((event) => event.eventType)).toEqual(expect.arrayContaining(['batch_started', 'batch_step_started', 'batch_step_completed', 'batch_completed']));
      expect(fixture.tasks.findById(task.id)?.executionMode).toBe('sequential_batch');
    } finally { await fixture.dispose(); }
  });

  it('does not start later batch steps after a failure', async () => {
    const fixture = await setup();
    try {
      const adapter = new FailingAdapter(); const service = fixture.service(adapter, 1_000);
      fixture.tasks.create({ workspaceId: fixture.workspace.id, prompt: '', requestedAgentId: null, requestedModelId: null, priority: 1, executionMode: 'sequential_batch', batchSteps: ['Fail.', 'Must not start.'] });
      service.schedule(); const run = await waitFor<Run | undefined>(() => service.list(fixture.workspace.id)[0]);
      await waitFor(() => service.find(run.id).then((value) => value?.status === 'failed' ? value : undefined));
      expect(adapter.starts).toBe(1); expect(service.batchSteps(run.id).map((step) => step.status)).toEqual(['failed', 'cancelled']);
    } finally { await fixture.dispose(); }
  });

  it('rejects a stale Delegated Leader task at the Run boundary', async () => {
    const fixture = await setup();
    try {
      const adapter = new CompletingAdapter(); const service = fixture.service(adapter, 1_000);
      fixture.tasks.create({ workspaceId: fixture.workspace.id, prompt: 'Stale mode.', requestedAgentId: null, requestedModelId: null, priority: 1, executionMode: 'delegated_leader', batchSteps: [] }); service.schedule();
      const run = await waitFor<Run | undefined>(() => service.list(fixture.workspace.id)[0]);
      const blocked = await waitFor(() => service.find(run.id).then((item) => item?.status === 'blocked' ? item : undefined));
      expect(adapter.starts).toBe(0); expect(blocked.failureReason).toContain('not supported');
    } finally { await fixture.dispose(); }
  });

  it('cancels the active batch step and does not start later steps', async () => {
    const fixture = await setup();
    try {
      const adapter = new TimeoutThenCompleteAdapter(); const service = fixture.service(adapter, 5_000);
      fixture.tasks.create({ workspaceId: fixture.workspace.id, prompt: '', requestedAgentId: null, requestedModelId: null, priority: 1, executionMode: 'sequential_batch', batchSteps: ['Wait.', 'Must not start.'] });
      service.schedule(); const run = await waitFor<Run | undefined>(() => service.list(fixture.workspace.id).find((item) => item.status === 'running'));
      await service.requestCancellation(run.id); await waitFor(() => service.find(run.id).then((item) => item?.status === 'cancelled' ? item : undefined));
      expect(adapter.launches).toBe(1); expect(service.batchSteps(run.id).map((step) => step.status)).toEqual(['cancelled', 'cancelled']);
    } finally { await fixture.dispose(); }
  });

  it('times out the active batch step and does not start later steps', async () => {
    const fixture = await setup();
    try {
      const adapter = new TimeoutThenCompleteAdapter(); const service = fixture.service(adapter, 20);
      fixture.tasks.create({ workspaceId: fixture.workspace.id, prompt: '', requestedAgentId: null, requestedModelId: null, priority: 1, executionMode: 'sequential_batch', batchSteps: ['Time out.', 'Must not start.'] });
      service.schedule(); const run = await waitFor<Run | undefined>(() => service.list(fixture.workspace.id)[0]);
      await waitFor(() => service.find(run.id).then((item) => item?.status === 'timed_out' ? item : undefined), 2_000);
      expect(adapter.launches).toBe(1); expect(service.batchSteps(run.id).map((step) => step.status)).toEqual(['timed_out', 'cancelled']);
    } finally { await fixture.dispose(); }
  });

  it('shares one timeout budget across all batch steps', async () => {
    const fixture = await setup();
    try {
      const adapter = new DelayedThenHangingAdapter(45); const service = fixture.service(adapter, 60);
      const task = fixture.tasks.create({ workspaceId: fixture.workspace.id, prompt: '', requestedAgentId: null, requestedModelId: null, priority: 1, executionMode: 'sequential_batch', batchSteps: ['Finish first.', 'Time out with remaining budget.'] });
      service.schedule(); const run = await waitFor<Run | undefined>(() => service.list(fixture.workspace.id)[0]);
      await waitFor(() => service.find(run.id).then((item) => item?.status === 'timed_out' ? item : undefined), 2_000);
      await waitFor(() => fixture.tasks.findById(task.id)?.status === 'failed' ? true : undefined);
      expect(adapter.starts).toBe(2); expect(adapter.cancelled).toBe(1); expect(adapter.cancelledAt! - adapter.secondStartedAt!).toBeLessThan(40);
    } finally { await fixture.dispose(); }
  });

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
      expect(service.events(completed.id, 'raw_protocol').events.map((event) => event.eventType)).toContain('agent_protocol');
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

  it('cancels during preparation without launching Claude', async () => {
    const fixture = await setup();
    try {
      const adapter = new CompletingAdapter(); const delayedWorktrees = new DelayedWorktreeService(fixture.worktreeService); const service = fixture.service(adapter, 5_000, delayedWorktrees);
      fixture.tasks.create({ workspaceId: fixture.workspace.id, prompt: 'Never launch.', requestedAgentId: null, requestedModelId: null, priority: 1 }); service.schedule();
      const run = await waitFor<Run | undefined>(() => service.list(fixture.workspace.id)[0]); await delayedWorktrees.waitForStart(); await service.requestCancellation(run.id); delayedWorktrees.release();
      const cancelled = await waitFor(() => service.find(run.id).then((value) => value?.status === 'cancelled' ? value : undefined));
      expect(adapter.starts).toBe(0); expect(cancelled.worktreePath).toBeTruthy(); expect(cancelled.finalGitState).toBeTruthy();
    } finally { await fixture.dispose(); }
  });

  it('keeps batch-step evidence when cancelled during preparation', async () => {
    const fixture = await setup();
    try {
      const adapter = new CompletingAdapter(); const delayedWorktrees = new DelayedWorktreeService(fixture.worktreeService); const service = fixture.service(adapter, 5_000, delayedWorktrees);
      fixture.tasks.create({ workspaceId: fixture.workspace.id, prompt: '', requestedAgentId: null, requestedModelId: null, priority: 1, executionMode: 'sequential_batch', batchSteps: ['Never run one.', 'Never run two.'] }); service.schedule();
      const run = await waitFor<Run | undefined>(() => service.list(fixture.workspace.id)[0]); await delayedWorktrees.waitForStart();
      expect(service.batchSteps(run.id).map((step) => step.prompt)).toEqual(['Never run one.', 'Never run two.']); await service.requestCancellation(run.id); delayedWorktrees.release();
      await waitFor(() => service.find(run.id).then((item) => item?.status === 'cancelled' ? item : undefined));
      expect(adapter.starts).toBe(0); expect(service.batchSteps(run.id).map((step) => step.status)).toEqual(['cancelled', 'cancelled']);
    } finally { await fixture.dispose(); }
  });

  it('cancels a handle that arrives after cancellation during startRun handoff', async () => {
    const fixture = await setup();
    try {
      const adapter = new DeferredStartAdapter(); const service = fixture.service(adapter, 5_000);
      fixture.tasks.create({ workspaceId: fixture.workspace.id, prompt: 'Cancel handoff.', requestedAgentId: null, requestedModelId: null, priority: 1 }); service.schedule();
      const run = await waitFor<Run | undefined>(() => service.list(fixture.workspace.id)[0]); await adapter.waitForStart(); await service.requestCancellation(run.id); adapter.releaseHandle();
      const cancelled = await waitFor(() => service.find(run.id).then((value) => value?.status === 'cancelled' ? value : undefined));
      expect(adapter.cancelled).toBe(1); expect(cancelled.status).toBe('cancelled');
    } finally { await fixture.dispose(); }
  });
});

const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), 'nightshift-planner-'));
  const repository = join(root, 'repository'); const worktrees = join(root, 'worktrees');
  await exec('git', ['init', repository]); await exec('git', ['-C', repository, 'config', 'user.email', 'test@nightshift.local']); await exec('git', ['-C', repository, 'config', 'user.name', 'NightShift Test']);
  await writeFile(join(repository, 'marker.txt'), 'base\n'); await exec('git', ['-C', repository, 'add', '.']); await exec('git', ['-C', repository, 'commit', '-m', 'base']);
  const database = new DatabaseService(':memory:'); const workspaces = new WorkspaceRepository(database); const tasks = new PlannerTaskRepository(database); const runs = new RunRepository(database); const workspace = workspaces.addOrTouch(repository, 'repository', true);
  const worktreeService = new GitWorktreeService(worktrees);
  return { repository, workspace, tasks, worktreeService, service: (adapter: AgentAdapter, timeoutMs: number, selectedWorktrees: WorktreeService = worktreeService) => new RunService(runs, tasks, workspaces, selectedWorktrees, new Map([[adapter.id, adapter]]), { agentId: adapter.id, modelId: 'nvidia_nim/nvidia/nemotron-3-super-120b-a12b', timeoutMs }), dispose: async () => { database.close(); await rm(root, { recursive: true, force: true }); } };
};

class CompletingAdapter implements AgentAdapter {
  public readonly id = 'claude-code'; public starts = 0; public readonly workingDirectories: string[] = []; public capabilities = (): AgentCapabilities => capabilities; public detect = (): Promise<AgentDescriptor> => Promise.resolve({ id: this.id, displayName: 'Test', fccLauncher: 'test', installed: true, launchable: true, version: null, capabilities, lastValidatedAt: null });
  public async startRun(spec: RunStartSpec): Promise<AgentExecutionHandle> { this.starts += 1; this.workingDirectories.push(spec.workingDirectory); const event = { sequence: 0, timestamp: new Date().toISOString(), raw: '{"type":"system"}', parsed: { type: 'system' }, type: 'system', externalSessionId: 'session-test', terminal: false, parseError: null }; spec.onProtocolEvent?.(event); await writeFile(join(spec.workingDirectory, 'marker.txt'), 'changed by planner\n'); return { handleId: randomUUID(), externalSessionId: 'session-test', events: [event], completion: Promise.resolve({ handleId: 'complete', succeeded: true, failureReason: null, exitCode: 0, signal: null, externalSessionId: 'session-test', events: [event], terminalEvent: { ...event, terminal: true }, stderr: '' }) }; }
  public startWorker(): Promise<AgentExecutionHandle> { return Promise.reject(new Error('not implemented')); } public cancel(): Promise<void> { return Promise.resolve(); }
}
class FailingAdapter extends CompletingAdapter {
  public override startRun(spec: RunStartSpec): Promise<AgentExecutionHandle> { this.starts += 1; this.workingDirectories.push(spec.workingDirectory); return Promise.resolve({ handleId: randomUUID(), externalSessionId: null, events: [], completion: Promise.resolve({ handleId: 'failed', succeeded: false, failureReason: 'Expected failure.', exitCode: 1, signal: null, externalSessionId: null, events: [], terminalEvent: null, stderr: '' }) }); }
}
class TimeoutThenCompleteAdapter extends CompletingAdapter {
  public cancelled = 0; public launches = 0; private resolve?: (value: AgentExecutionResult) => void;
  public override async startRun(spec: RunStartSpec): Promise<AgentExecutionHandle> { this.launches += 1; if (this.launches > 1) return super.startRun(spec); const handleId = randomUUID(); let resolveCompletion!: (result: AgentExecutionResult) => void; const completion = new Promise<AgentExecutionResult>((resolve) => { resolveCompletion = resolve; }); this.resolve = resolveCompletion; return { handleId, externalSessionId: null, events: [], completion }; }
  public override cancel(): Promise<void> { this.cancelled += 1; this.resolve?.({ handleId: 'timeout', succeeded: false, failureReason: 'cancelled', exitCode: null, signal: 'SIGTERM', externalSessionId: null, events: [], terminalEvent: null, stderr: '' }); return Promise.resolve(); }
}
class DelayedThenHangingAdapter extends CompletingAdapter {
  public cancelled = 0; public secondStartedAt?: number; public cancelledAt?: number; private resolve?: (value: AgentExecutionResult) => void;
  public constructor(private readonly firstDelayMs: number) { super(); }
  public override startRun(spec: RunStartSpec): Promise<AgentExecutionHandle> {
    this.starts += 1; this.workingDirectories.push(spec.workingDirectory);
    if (this.starts === 1) {
      const completion = new Promise<AgentExecutionResult>((resolve) => setTimeout(() => resolve({ handleId: 'first', succeeded: true, failureReason: null, exitCode: 0, signal: null, externalSessionId: 'first', events: [], terminalEvent: null, stderr: '' }), this.firstDelayMs));
      return Promise.resolve({ handleId: 'first', externalSessionId: 'first', events: [], completion });
    }
    this.secondStartedAt = Date.now();
    const completion = new Promise<AgentExecutionResult>((resolve) => { this.resolve = resolve; });
    return Promise.resolve({ handleId: 'second', externalSessionId: 'second', events: [], completion });
  }
  public override cancel(): Promise<void> { this.cancelled += 1; this.cancelledAt = Date.now(); this.resolve?.({ handleId: 'second', succeeded: false, failureReason: 'Timed out.', exitCode: null, signal: 'SIGTERM', externalSessionId: 'second', events: [], terminalEvent: null, stderr: '' }); return Promise.resolve(); }
}
class DeferredStartAdapter extends CompletingAdapter {
  public cancelled = 0; private resolveStart?: (handle: AgentExecutionHandle) => void; private resolveCompletion?: (result: AgentExecutionResult) => void; private readonly started = deferred<void>();
  public override startRun(): Promise<AgentExecutionHandle> { this.starts += 1; this.started.resolve(); return new Promise((resolve) => { this.resolveStart = resolve; }); }
  public waitForStart(): Promise<void> { return this.started.promise; }
  public releaseHandle(): void { let resolveCompletion!: (result: AgentExecutionResult) => void; const completion = new Promise<AgentExecutionResult>((resolve) => { resolveCompletion = resolve; }); this.resolveCompletion = resolveCompletion; this.resolveStart?.({ handleId: 'late-handle', externalSessionId: null, events: [], completion }); }
  public override cancel(): Promise<void> { this.cancelled += 1; this.resolveCompletion?.({ handleId: 'late-handle', succeeded: false, failureReason: 'cancelled', exitCode: null, signal: 'SIGTERM', externalSessionId: null, events: [], terminalEvent: null, stderr: '' }); return Promise.resolve(); }
}
class DelayedWorktreeService implements WorktreeService {
  private readonly started = deferred<void>(); private readonly gate = deferred<void>();
  public constructor(private readonly inner: WorktreeService) {}
  public async createForRun(spec: WorktreeSpec): Promise<WorktreeHandle> { this.started.resolve(); await this.gate.promise; return this.inner.createForRun(spec); }
  public inspect(path: string): Promise<WorktreeHandle | undefined> { return this.inner.inspect(path); }
  public removeAfterEvidencePersisted(path: string): Promise<void> { return this.inner.removeAfterEvidencePersisted(path); }
  public waitForStart(): Promise<void> { return this.started.promise; } public release(): void { this.gate.resolve(); }
}
const deferred = <T>(): { promise: Promise<T>; resolve: (value: T) => void } => { let resolve!: (value: T) => void; return { promise: new Promise<T>((next) => { resolve = next; }), resolve }; };
const waitFor = async <T>(get: () => T | Promise<T>, timeoutMs = 1_000): Promise<NonNullable<T>> => { const until = Date.now() + timeoutMs; for (;;) { const value = await get(); if (value) return value; if (Date.now() >= until) throw new Error('Condition timed out.'); await new Promise((resolve) => setTimeout(resolve, 10)); } };
