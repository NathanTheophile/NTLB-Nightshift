import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { DatabaseService } from '../src/main/persistence/DatabaseService';
import { PlannerTaskRepository } from '../src/main/persistence/repositories/PlannerTaskRepository';
import { WorkspaceRepository } from '../src/main/persistence/repositories/WorkspaceRepository';
import { WorkerRepository } from '../src/main/persistence/repositories/WorkerRepository';
import { SettingsRepository } from '../src/main/persistence/repositories/SettingsRepository';
import { WorkspaceService } from '../src/main/services/WorkspaceService';

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
    expect(firstOpen.schemaVersion()).toBe(4);
    firstOpen.close();

    const secondOpen = new DatabaseService(databasePath);
    expect(secondOpen.schemaVersion()).toBe(4);
    expect(
      secondOpen
        .queryAll<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .map(({ name }) => name),
    ).toEqual(expect.arrayContaining(['workspaces', 'tasks', 'runs', 'run_events', 'workers', 'chats', 'agents', 'models']));
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
    expect(tasks.listVisible(workspace.id)).toEqual([task]);
    expect(workspaces.list()).toEqual([workspace]);
    database.close();
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
