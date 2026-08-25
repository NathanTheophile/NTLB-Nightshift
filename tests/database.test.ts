import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { DatabaseService } from '../src/main/persistence/DatabaseService';
import { PlannerTaskRepository } from '../src/main/persistence/repositories/PlannerTaskRepository';
import { WorkspaceRepository } from '../src/main/persistence/repositories/WorkspaceRepository';
import { WorkerRepository } from '../src/main/persistence/repositories/WorkerRepository';
import { SettingsRepository } from '../src/main/persistence/repositories/SettingsRepository';
import { WorkspaceService } from '../src/main/services/WorkspaceService';
import { PlannerService } from '../src/main/services/PlannerService';
import { migrations } from '../src/main/persistence/migrations';
import { RunRepository } from '../src/main/persistence/repositories/RunRepository';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('DatabaseService', () => {
  it('applies every ordered migration and remains idempotent', () => {
    const directory = mkdtempSync(join(tmpdir(), 'nightshift-db-'));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, 'nightshift.sqlite');

    const firstOpen = new DatabaseService(databasePath);
    expect(firstOpen.schemaVersion()).toBe(10);
    firstOpen.close();

    const secondOpen = new DatabaseService(databasePath);
    expect(secondOpen.schemaVersion()).toBe(10);
    expect(
      secondOpen
        .queryAll<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .map(({ name }) => name),
    ).toEqual(expect.arrayContaining(['workspaces', 'tasks', 'runs', 'run_events', 'workers', 'chats', 'agents', 'models', 'planner_batch_steps', 'run_batch_steps', 'run_attempts']));
    secondOpen.close();
  });

  it('persists a workspace and a real queued Planner task', () => {
    const database = new DatabaseService(':memory:');
    const workspaces = new WorkspaceRepository(database);
    const tasks = new PlannerTaskRepository(database);

    const workspace = workspaces.addOrTouch('C:\\projects\\nightshift-test', 'nightshift-test', true);
    const task = tasks.create({
      workspaceId: workspace.id,
      prompt: 'Document the typed IPC boundary.',
      requestedAgentId: null,
      requestedModelId: null,
      priority: 1,
    });

    expect(task.status).toBe('queued');
    expect(task.executionMode).toBe('single_agent');
    expect(tasks.listVisible(workspace.id)).toEqual([task]);
    expect(workspaces.list()).toEqual([workspace]);
    database.close();
  });

  it('rejects unsupported and invalid Planner execution modes', () => {
    const database = new DatabaseService(':memory:'); const workspaces = new WorkspaceRepository(database); const tasks = new PlannerTaskRepository(database); const workspace = workspaces.addOrTouch('C:\\projects\\nightshift-test', 'nightshift-test', true); const planner = new PlannerService(tasks, workspaces);
    expect(planner.createTask({ workspaceId: workspace.id, prompt: 'Delegate.', requestedAgentId: null, requestedModelId: null, priority: 1, executionMode: 'delegated_leader', batchSteps: [] }).executionMode).toBe('delegated_leader');
    expect(() => planner.createTask({ workspaceId: workspace.id, prompt: '', requestedAgentId: null, requestedModelId: null, priority: 1, executionMode: 'sequential_batch', batchSteps: [' '] })).toThrow('non-empty ordered steps');
    expect(() => planner.createTask({ workspaceId: workspace.id, prompt: '', requestedAgentId: null, requestedModelId: null, priority: 1, executionMode: 'sequential_batch', batchSteps: Array.from({ length: 33 }, () => 'Step') })).toThrow('between 1 and 32');
    database.close();
  });

  it('uses the first batch step as the title when shared context is empty', () => {
    const database = new DatabaseService(':memory:'); const workspaces = new WorkspaceRepository(database); const tasks = new PlannerTaskRepository(database); const workspace = workspaces.addOrTouch('C:\\projects\\nightshift-test', 'nightshift-test', true);
    const task = tasks.create({ workspaceId: workspace.id, prompt: '', requestedAgentId: null, requestedModelId: null, priority: 1, executionMode: 'sequential_batch', batchSteps: ['Inspect the serialized run evidence.', 'Do the follow-up.'] });
    expect(task.title).toBe('Inspect the serialized run evidence.'); expect(tasks.batchSteps(task.id)).toEqual(['Inspect the serialized run evidence.', 'Do the follow-up.']); database.close();
  });

  it('migrates real pre-v5 Tasks and Runs to Single Agent', () => {
    const directory = mkdtempSync(join(tmpdir(), 'nightshift-pre-v5-')); temporaryDirectories.push(directory); const databasePath = join(directory, 'nightshift.sqlite'); const legacy = new DatabaseSync(databasePath);
    legacy.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);');
    migrations.filter((migration) => migration.version < 5).forEach((migration) => { legacy.exec(migration.sql); legacy.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)').run(migration.version, migration.name, '2026-08-25T00:00:00.000Z'); });
    legacy.prepare("INSERT INTO workspaces(id, root_path, display_name, is_git, created_at, last_opened_at) VALUES ('workspace', 'C:\\legacy', 'legacy', 1, '2026-08-25T00:00:00.000Z', '2026-08-25T00:00:00.000Z')").run();
    legacy.prepare("INSERT INTO tasks(id, workspace_id, prompt, title, priority, status, visible_in_planner, created_at, updated_at) VALUES ('task', 'workspace', 'Legacy task', 'Legacy task', 1, 'completed', 1, '2026-08-25T00:00:00.000Z', '2026-08-25T00:00:00.000Z')").run();
    legacy.prepare("INSERT INTO runs(id, task_id, workspace_id, resolved_agent_id, resolved_model_id, status, created_at) VALUES ('run', 'task', 'workspace', 'claude-code', 'model', 'completed', '2026-08-25T00:00:00.000Z')").run(); legacy.close();
    const migrated = new DatabaseService(databasePath); const tasks = new PlannerTaskRepository(migrated); const runs = migrated.queryOne<{ execution_mode: string }>('SELECT execution_mode FROM runs WHERE id = ?', 'run');
    expect(tasks.findById('task')?.executionMode).toBe('single_agent'); expect(runs?.execution_mode).toBe('single_agent'); migrated.close();
  });

  it('persists candidate publication state and immutable follow-up provenance', () => {
    const database = new DatabaseService(':memory:'); const workspaces = new WorkspaceRepository(database); const tasks = new PlannerTaskRepository(database); const runs = new RunRepository(database); const workspace = workspaces.addOrTouch('C:\\projects\\candidate', 'candidate', true);
    const task = tasks.create({ workspaceId: workspace.id, prompt: 'Implement the candidate.', requestedAgentId: null, requestedModelId: null, priority: 1 });
    const source = runs.create({ taskId: task.id, workspaceId: workspace.id, resolvedAgentId: 'codex', resolvedModelId: 'model' });
    runs.setStatus(source.id, 'completed'); runs.setCandidateCommit(source.id, 'nightshift/run/source-candidate', 'candidate-sha');
    expect(runs.tryBeginCandidatePublish(source.id)).toBe(true); expect(runs.tryBeginCandidatePublish(source.id)).toBe(false);
    runs.setCandidatePublishFailure(source.id, 'Remote rejected candidate.'); expect(runs.tryBeginCandidatePublish(source.id)).toBe(true);
    const published = runs.setCandidatePublished(source.id, 'origin');
    expect(published).toMatchObject({ candidateBranchName: 'nightshift/run/source-candidate', candidateCommitSha: 'candidate-sha', candidateRemoteName: 'origin', candidatePublishState: 'published', candidateFailureReason: null });
    const followUp = runs.create({ taskId: task.id, workspaceId: workspace.id, resolvedAgentId: source.resolvedAgentId, resolvedModelId: source.resolvedModelId, sourceRunId: source.id, followUpPrompt: 'Correct review issue.' });
    expect(followUp).toMatchObject({ sourceRunId: source.id, followUpPrompt: 'Correct review issue.', candidatePublishState: 'not_published' }); database.close();
  });

  it('persists ordered open tabs without deleting remembered workspaces', () => {
    const database = new DatabaseService(':memory:');
    const workspaces = new WorkspaceRepository(database);
    const settings = new SettingsRepository(database);
    const service = new WorkspaceService(workspaces, settings);
    const alpha = workspaces.addOrTouch('C:\\projects\\alpha', 'alpha', true);
    const beta = workspaces.addOrTouch('C:\\projects\\beta', 'beta', true);

    service.saveTabState({ workspaceIds: [alpha.id], activeWorkspaceId: alpha.id });
    expect(service.getOpenTabs()).toEqual({ workspaces: [alpha], activeWorkspaceId: alpha.id });
    expect(workspaces.list()).toHaveLength(2);

    service.saveTabState({ workspaceIds: [beta.id, alpha.id], activeWorkspaceId: beta.id });
    expect(service.getOpenTabs()).toEqual({ workspaces: [beta, alpha], activeWorkspaceId: beta.id });
    database.close();
  });

  it('restores Worker configuration and ordered events after reopening SQLite', () => {
    const directory = mkdtempSync(join(tmpdir(), 'nightshift-worker-db-')); temporaryDirectories.push(directory);
    const databasePath = join(directory, 'nightshift.sqlite'); const first = new DatabaseService(databasePath); const workspaces = new WorkspaceRepository(first); const workspace = workspaces.addOrTouch('C:\\projects\\worker', 'worker', true); const workers = new WorkerRepository(first);
    const worker = workers.create({ id: 'worker-1', workspaceId: workspace.id, title: 'Persistent Worker', agentId: 'claude-code', modelId: 'model', permissionProfile: 'workspace_write', isolationMode: 'direct_workspace', workingDirectory: workspace.rootPath, baseSha: null }); workers.appendEvent(worker.id, 'user', 'First message', { role: 'user' }); workers.appendEvent(worker.id, 'assistant', 'First answer', { role: 'assistant' }); first.close();
    const reopenedDatabase = new DatabaseService(databasePath); const reopened = new WorkerRepository(reopenedDatabase);
    expect(reopened.find('worker-1')).toMatchObject({ agentId: 'claude-code', modelId: 'model', permissionProfile: 'workspace_write', isolationMode: 'direct_workspace', workingDirectory: workspace.rootPath }); expect(reopened.listEvents('worker-1').map(({ sequence, content }) => [sequence, content])).toEqual([[0, 'First message'], [1, 'First answer']]); reopenedDatabase.close();
  });
});
