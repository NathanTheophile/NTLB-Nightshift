import { describe, expect, it } from 'vitest';

import { DatabaseService } from '../src/main/persistence/DatabaseService';
import { PlannerTaskRepository } from '../src/main/persistence/repositories/PlannerTaskRepository';
import { RunRepository } from '../src/main/persistence/repositories/RunRepository';
import { SettingsRepository } from '../src/main/persistence/repositories/SettingsRepository';
import { WorkspaceRepository } from '../src/main/persistence/repositories/WorkspaceRepository';
import { RunService } from '../src/main/services/RunService';
import type { WorktreeService } from '../src/main/services/contracts/WorktreeService';

describe('Night queue hardening', () => {
  it('persists pause state, blocks queued claims, and resumes the scheduler', async () => {
    const database = new DatabaseService(':memory:'); const workspaces = new WorkspaceRepository(database); const tasks = new PlannerTaskRepository(database); const settings = new SettingsRepository(database); const workspace = workspaces.addOrTouch('C:\\queue', 'queue', true);
    const service = new RunService(new RunRepository(database), tasks, workspaces, {} as never, new Map(), { agentId: 'agent', modelId: 'model', timeoutMs: 1_000 }, undefined, settings);
    const task = tasks.create({ workspaceId: workspace.id, prompt: 'Wait.', requestedAgentId: null, requestedModelId: null, priority: 1 });
    service.setQueuePaused(true); service.schedule();
    expect(tasks.findById(task.id)?.status).toBe('queued'); expect(new RunService(new RunRepository(database), tasks, workspaces, {} as never, new Map(), { agentId: 'agent', modelId: 'model', timeoutMs: 1_000 }, undefined, settings).queuePaused()).toBe(true);
    service.setQueuePaused(false); await waitFor(() => tasks.findById(task.id)?.status !== 'queued'); await waitFor(() => service.list(workspace.id).every((run) => ['completed', 'failed', 'blocked', 'cancelled', 'timed_out'].includes(run.status))); await new Promise((resolve) => setTimeout(resolve, 10));
    database.close();
  });

  it('deletes only queued tasks, reprioritizes canonically, and preserves batch-step integrity on refusal', () => {
    const database = new DatabaseService(':memory:'); const workspaces = new WorkspaceRepository(database); const tasks = new PlannerTaskRepository(database); const workspace = workspaces.addOrTouch('C:\\queue', 'queue', true);
    const task = tasks.create({ workspaceId: workspace.id, prompt: '', requestedAgentId: null, requestedModelId: null, priority: 1, executionMode: 'sequential_batch', batchSteps: ['One'] });
    const later = tasks.create({ workspaceId: workspace.id, prompt: 'Later.', requestedAgentId: null, requestedModelId: null, priority: 2 }); tasks.updateQueuedPriority(later.id, 1);
    expect(tasks.nextQueued()?.id).toBe(task.id);
    tasks.deleteQueued(task.id); expect(tasks.findById(task.id)).toBeUndefined();
    const running = tasks.create({ workspaceId: workspace.id, prompt: '', requestedAgentId: null, requestedModelId: null, priority: 1, executionMode: 'sequential_batch', batchSteps: ['One'] }); tasks.setStatus(running.id, 'running');
    expect(() => tasks.deleteQueued(running.id)).toThrow('Only queued'); expect(tasks.batchSteps(running.id)).toEqual(['One']); database.close();
  });

  it('purges a complete terminal follow-up chain and its local worktrees without touching candidate metadata remotely', async () => {
    const database = new DatabaseService(':memory:'); const workspaces = new WorkspaceRepository(database); const tasks = new PlannerTaskRepository(database); const runs = new RunRepository(database); const workspace = workspaces.addOrTouch('C:\\purge', 'purge', true); const removed: string[] = [];
    const worktrees: WorktreeService = { createForRun: () => Promise.reject(new Error('unused')), inspect: () => Promise.resolve(undefined), removeAfterEvidencePersisted: (path) => { removed.push(path); return Promise.resolve(); } };
    const task = tasks.create({ workspaceId: workspace.id, prompt: 'Purge.', requestedAgentId: null, requestedModelId: null, priority: 1 }); tasks.setStatus(task.id, 'completed');
    const source = runs.create({ taskId: task.id, workspaceId: workspace.id, resolvedAgentId: 'agent', resolvedModelId: 'model' }); runs.setPreparation(source.id, 'base', 'C:\\worktrees\\source'); runs.setStatus(source.id, 'completed'); runs.setCandidateCommit(source.id, 'nightshift/run/source', 'candidate'); runs.setCandidatePublished(source.id, 'origin'); runs.appendEvent(source.id, 'terminal', {});
    const followUp = runs.create({ taskId: task.id, workspaceId: workspace.id, resolvedAgentId: 'agent', resolvedModelId: 'model', sourceRunId: source.id }); runs.setPreparation(followUp.id, 'candidate', 'C:\\worktrees\\follow'); runs.setStatus(followUp.id, 'failed'); runs.appendEvent(followUp.id, 'terminal', {});
    const artifactRuns: string[][] = [];
    const service = new RunService(runs, tasks, workspaces, worktrees, new Map(), { agentId: 'agent', modelId: 'model', timeoutMs: 1_000 }, undefined, undefined, undefined, { removeForRuns: (history) => { artifactRuns.push(history.map((run) => run.id)); return Promise.resolve(); } });
    await service.purgePlannerTask(task.id);
    expect(removed).toEqual(['C:\\worktrees\\source', 'C:\\worktrees\\follow']); expect(artifactRuns).toEqual([[source.id, followUp.id]]); expect(tasks.findById(task.id)).toBeUndefined(); expect(runs.listByTask(task.id)).toEqual([]); expect(database.queryAll('SELECT * FROM run_events')).toEqual([]); database.close();
  });

  it('refuses purge while any associated Run is active', async () => {
    const database = new DatabaseService(':memory:'); const workspaces = new WorkspaceRepository(database); const tasks = new PlannerTaskRepository(database); const runs = new RunRepository(database); const workspace = workspaces.addOrTouch('C:\\purge', 'purge', true); const task = tasks.create({ workspaceId: workspace.id, prompt: 'Keep.', requestedAgentId: null, requestedModelId: null, priority: 1 }); tasks.setStatus(task.id, 'failed'); runs.create({ taskId: task.id, workspaceId: workspace.id, resolvedAgentId: 'agent', resolvedModelId: 'model' });
    const service = new RunService(runs, tasks, workspaces, {} as never, new Map(), { agentId: 'agent', modelId: 'model', timeoutMs: 1_000 });
    await expect(service.purgePlannerTask(task.id)).rejects.toThrow('active'); expect(tasks.findById(task.id)).toBeDefined(); database.close();
  });
});

const waitFor = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 1_000;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error('Timed out.'); await new Promise((resolve) => setTimeout(resolve, 10)); }
};
