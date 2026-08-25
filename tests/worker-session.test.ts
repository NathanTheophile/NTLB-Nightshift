import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { DatabaseService } from '../src/main/persistence/DatabaseService';
import { WorkerRepository } from '../src/main/persistence/repositories/WorkerRepository';
import { WorkspaceRepository } from '../src/main/persistence/repositories/WorkspaceRepository';
import { WorkerSessionService } from '../src/main/services/WorkerSessionService';
import type { AgentAdapter, AgentExecutionHandle, AgentExecutionResult, AgentProtocolEvent, WorkerStartSpec } from '../src/main/services/contracts/AgentAdapter';
import type { WorktreeHandle, WorktreeService, WorktreeSpec } from '../src/main/services/contracts/WorktreeService';
import type { AgentCapabilities, AgentDescriptor } from '../src/shared/domain/entities';

const capabilities: AgentCapabilities = { interactive: true, headless: true, structuredEvents: true, rawPty: false, resume: true, modelOverride: true, cancel: true, workingDirectory: true, imageInput: false, subagents: false, plannerValidated: true, workerValidated: true, renderMode: 'structured' };

describe('WorkerSessionService', () => {
  it('persists locked configuration, ordered structured history, and session continuation across service restart', async () => {
    const database = new DatabaseService(':memory:'); const workspaces = new WorkspaceRepository(database); const repository = new WorkerRepository(database); const workspace = workspaces.addOrTouch('C:\\project', 'project', true); const adapter = new WorkerAdapter();
    const service = new WorkerSessionService(repository, workspaces, new FakeWorktrees(), new Map([[adapter.id, adapter]]), () => Promise.resolve('base-sha'));
    const worker = await service.create({ workspaceId: workspace.id, title: 'Investigate bug', agentId: adapter.id, modelId: 'model', permissionProfile: 'workspace_write', isolationMode: 'direct_workspace' });
    await service.send(worker.id, 'Inspect the failure.'); const restored = new WorkerSessionService(repository, workspaces, new FakeWorktrees(), new Map([[adapter.id, adapter]])); await restored.send(worker.id, 'Now fix it.');
    const saved = await restored.find(worker.id); const events = await restored.events(worker.id);
    expect(saved).toMatchObject({ title: 'Investigate bug', agentId: 'claude-code', modelId: 'model', permissionProfile: 'workspace_write', isolationMode: 'direct_workspace', externalSessionId: 'session-1', status: 'waiting_for_user' });
    expect(events.map(({ roleOrType }) => roleOrType)).toEqual(['system', 'user', 'assistant', 'user', 'assistant']); expect(events.map(({ sequence }) => sequence)).toEqual([0, 1, 2, 3, 4]); expect(adapter.specs[1]?.externalSessionId).toBe('session-1');
    database.close();
  });

  it('uses WorktreeService only for isolated write and rejects incoherent permission/isolation', async () => {
    const database = new DatabaseService(':memory:'); const workspaces = new WorkspaceRepository(database); const repository = new WorkerRepository(database); const workspace = workspaces.addOrTouch('C:\\project', 'project', true); const worktrees = new FakeWorktrees(); const adapter = new WorkerAdapter(); const service = new WorkerSessionService(repository, workspaces, worktrees, new Map([[adapter.id, adapter]]), () => Promise.resolve('base-sha'));
    await service.create({ workspaceId: workspace.id, title: 'Direct', agentId: adapter.id, modelId: 'model', permissionProfile: 'read_only', isolationMode: 'direct_workspace' });
    const isolated = await service.create({ workspaceId: workspace.id, title: 'Isolated', agentId: adapter.id, modelId: 'model', permissionProfile: 'isolated_write', isolationMode: 'isolated_worktree' });
    await expect(service.create({ workspaceId: workspace.id, title: 'Invalid', agentId: adapter.id, modelId: 'model', permissionProfile: 'isolated_write', isolationMode: 'direct_workspace' })).rejects.toThrow('requires isolated_worktree');
    expect(worktrees.calls).toHaveLength(1); expect(isolated.workingDirectory).toBe('C:\\worktrees\\worker'); database.close();
  });

  it('rejects a Worker Agent × Model pair without explicit validation evidence', async () => {
    const database = new DatabaseService(':memory:'); const workspaces = new WorkspaceRepository(database); const repository = new WorkerRepository(database); const workspace = workspaces.addOrTouch('C:\\project', 'project', true); const adapter = new WorkerAdapter(); const service = new WorkerSessionService(repository, workspaces, new FakeWorktrees(), new Map([[adapter.id, adapter]]), () => Promise.resolve('base-sha'));
    await expect(service.create({ workspaceId: workspace.id, title: 'Unsupported', agentId: adapter.id, modelId: 'other-model', permissionProfile: 'workspace_write', isolationMode: 'direct_workspace' })).rejects.toThrow('not validated for Workers'); database.close();
  });

  it('cancels a late Worker handle when termination happens during startWorker handoff', async () => {
    const database = new DatabaseService(':memory:'); const workspaces = new WorkspaceRepository(database); const repository = new WorkerRepository(database); const workspace = workspaces.addOrTouch('C:\\project', 'project', true); const adapter = new DeferredStartWorkerAdapter(); const service = new WorkerSessionService(repository, workspaces, new FakeWorktrees(), new Map([[adapter.id, adapter]]), () => Promise.resolve('base-sha')); const worker = await service.create({ workspaceId: workspace.id, title: 'Handoff', agentId: adapter.id, modelId: 'model', permissionProfile: 'workspace_write', isolationMode: 'direct_workspace' });
    const sending = service.send(worker.id, 'Start then stop.'); await adapter.waitForStart(); await service.terminate(worker.id); adapter.releaseHandle(); await sending;
    expect(adapter.cancelled).toEqual([adapter.handleId]); expect((await service.find(worker.id))?.status).toBe('terminated'); database.close();
  });

  it('rejects a concurrent send while startWorker is unresolved', async () => {
    const database = new DatabaseService(':memory:'); const workspaces = new WorkspaceRepository(database); const repository = new WorkerRepository(database); const workspace = workspaces.addOrTouch('C:\\project', 'project', true); const adapter = new DeferredStartWorkerAdapter(); const service = new WorkerSessionService(repository, workspaces, new FakeWorktrees(), new Map([[adapter.id, adapter]]), () => Promise.resolve('base-sha')); const worker = await service.create({ workspaceId: workspace.id, title: 'One turn', agentId: adapter.id, modelId: 'model', permissionProfile: 'workspace_write', isolationMode: 'direct_workspace' });
    const first = service.send(worker.id, 'First.'); await adapter.waitForStart(); await expect(service.send(worker.id, 'Second.')).rejects.toThrow('still responding'); adapter.releaseHandle(); await first; expect(adapter.starts).toBe(1); database.close();
  });

  it('cancels only the active owned Agent handle and persists termination', async () => {
    const database = new DatabaseService(':memory:'); const workspaces = new WorkspaceRepository(database); const repository = new WorkerRepository(database); const workspace = workspaces.addOrTouch('C:\\project', 'project', true); const adapter = new WorkerAdapter(true); const service = new WorkerSessionService(repository, workspaces, new FakeWorktrees(), new Map([[adapter.id, adapter]]), () => Promise.resolve('base-sha')); const worker = await service.create({ workspaceId: workspace.id, title: 'Stop', agentId: adapter.id, modelId: 'model', permissionProfile: 'workspace_write', isolationMode: 'direct_workspace' });
    const sending = service.send(worker.id, 'Long task.'); await new Promise((resolve) => setTimeout(resolve, 0)); await service.terminate(worker.id); adapter.completePending(); await sending.catch(() => undefined);
    expect(adapter.cancelled).toEqual([adapter.handleId]); expect((await service.find(worker.id))?.status).toBe('terminated'); database.close();
  });
});

class FakeWorktrees implements WorktreeService {
  public calls: WorktreeSpec[] = [];
  public createForRun(spec: WorktreeSpec): Promise<WorktreeHandle> { this.calls.push(spec); return Promise.resolve({ path: 'C:\\worktrees\\worker', baseSha: spec.baseSha, branchName: 'detached' }); }
  public inspect(): Promise<WorktreeHandle | undefined> { return Promise.resolve(undefined); }
  public removeAfterEvidencePersisted(): Promise<void> { return Promise.resolve(); }
}
class WorkerAdapter implements AgentAdapter {
  public readonly id = 'claude-code'; public readonly specs: WorkerStartSpec[] = []; public readonly handleId = randomUUID(); public readonly cancelled: string[] = []; private resolve?: () => void;
  public constructor(private readonly pending = false) {}
  public capabilities = (): AgentCapabilities => capabilities;
  public supportsWorkerModel = (modelId: string): boolean => modelId === 'model';
  public detect = (): Promise<AgentDescriptor> => Promise.resolve({ id: this.id, displayName: 'Claude Code', fccLauncher: 'fcc-claude', installed: true, launchable: true, version: 'test', capabilities, lastValidatedAt: null });
  public startRun(): Promise<AgentExecutionHandle> { return Promise.reject(new Error('unused')); }
  public startWorker(spec: WorkerStartSpec): Promise<AgentExecutionHandle> { this.specs.push(spec); const event: AgentProtocolEvent = { sequence: 0, timestamp: '2026-08-25T00:00:00.000Z', raw: '{"type":"assistant"}', parsed: { type: 'assistant', message: { content: [{ text: 'Done.' }] } }, type: 'assistant', externalSessionId: 'session-1', terminal: false, parseError: null }; spec.onProtocolEvent?.(event); const completion: Promise<AgentExecutionResult> = this.pending ? new Promise<AgentExecutionResult>((resolve) => { this.resolve = () => resolve(result(this.handleId, event)); }) : Promise.resolve(result(this.handleId, event)); return Promise.resolve({ handleId: this.handleId, externalSessionId: 'session-1', events: [event], completion }); }
  public cancel(handleId: string): Promise<void> { this.cancelled.push(handleId); return Promise.resolve(); }
  public completePending(): void { this.resolve?.(); }
}
class DeferredStartWorkerAdapter extends WorkerAdapter {
  public starts = 0; private resolveStart?: (handle: AgentExecutionHandle) => void; private readonly started = deferred<void>();
  public override startWorker(spec: WorkerStartSpec): Promise<AgentExecutionHandle> { this.starts += 1; this.specs.push(spec); this.started.resolve(); return new Promise((resolve) => { this.resolveStart = resolve; }); }
  public waitForStart(): Promise<void> { return this.started.promise; }
  public releaseHandle(): void { const event: AgentProtocolEvent = { sequence: 0, timestamp: '2026-08-25T00:00:00.000Z', raw: '{"type":"assistant"}', parsed: { type: 'assistant' }, type: 'assistant', externalSessionId: 'session-1', terminal: false, parseError: null }; this.resolveStart?.({ handleId: this.handleId, externalSessionId: 'session-1', events: [event], completion: Promise.resolve(result(this.handleId, event)) }); }
}
const result = (handleId: string, event: AgentProtocolEvent) => ({ handleId, succeeded: true, failureReason: null, exitCode: 0, signal: null, externalSessionId: 'session-1', events: [event], terminalEvent: { ...event, terminal: true }, stderr: '' });
const deferred = <T>(): { promise: Promise<T>; resolve: (value: T) => void } => { let resolve!: (value: T) => void; return { promise: new Promise<T>((next) => { resolve = next; }), resolve }; };
