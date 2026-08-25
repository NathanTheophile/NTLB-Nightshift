import { execFile } from 'node:child_process';
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
import { WindowsProcessSupervisor } from '../src/main/services/WindowsProcessSupervisor';
import { ClaudeCodeAdapter } from '../src/main/services/agents/ClaudeCodeAdapter';
import { FccRuntimeManager } from '../src/main/services/runtime/FccRuntimeManager';
import { LocalFccGateway } from '../src/main/services/runtime/LocalFccGateway';

const exec = promisify(execFile);
const enabled = process.env.NIGHTSHIFT_RUN_FCC_PROBE === '1';

describe.skipIf(!enabled)('Planner → Run real FCC probe', () => {
  it('keeps the user workspace untouched and persists the isolated Claude result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nightshift-real-planner-')); const repository = join(root, 'repo'); const database = new DatabaseService(':memory:');
    const supervisor = new WindowsProcessSupervisor(); const gateway = new LocalFccGateway(new FccRuntimeManager({ supervisor }));
    try {
      await exec('git', ['init', repository]); await exec('git', ['-C', repository, 'config', 'user.email', 'test@nightshift.local']); await exec('git', ['-C', repository, 'config', 'user.name', 'NightShift Test']); await writeFile(join(repository, 'README.md'), 'base\n'); await exec('git', ['-C', repository, 'add', '.']); await exec('git', ['-C', repository, 'commit', '-m', 'base']);
      const workspaces = new WorkspaceRepository(database); const tasks = new PlannerTaskRepository(database); const runs = new RunRepository(database); const workspace = workspaces.addOrTouch(repository, 'repo', true);
      const adapter = new ClaudeCodeAdapter(supervisor, gateway); const service = new RunService(runs, tasks, workspaces, new GitWorktreeService(join(root, 'worktrees')), new Map([[adapter.id, adapter]]), { agentId: adapter.id, modelId: 'nvidia_nim/nvidia/nemotron-3-super-120b-a12b', timeoutMs: 180_000 });
      tasks.create({ workspaceId: workspace.id, prompt: 'Create NIGHTSHIFT_AGENT_PROBE.txt in the repository root. Its complete contents must be exactly NIGHTSHIFT_AGENT_PROBE_OK. Do not modify any other file. Then report completion.', requestedAgentId: null, requestedModelId: null, priority: 1 }); service.schedule();
      const run = await waitFor(() => service.list(workspace.id)[0]); const completed = await waitFor(() => service.find(run.id).then((value) => value?.status === 'completed' ? value : undefined), 210_000);
      expect(await readFile(join(repository, 'README.md'), 'utf8')).toBe('base\n'); expect(await readFile(join(completed.worktreePath!, 'NIGHTSHIFT_AGENT_PROBE.txt'), 'utf8')).toBe('NIGHTSHIFT_AGENT_PROBE_OK'); expect(completed.externalSessionId).toBeTruthy(); expect(completed.baseSha).toBeTruthy(); expect(completed.finalGitState).toBeTruthy(); expect(service.events(completed.id, 'raw_protocol').events.some((event) => event.eventType === 'agent_protocol')).toBe(true);
    } finally { await gateway.stopOwnedProcess(); database.close(); await rm(root, { recursive: true, force: true }); }
  }, 240_000);
});

const waitFor = async <T>(get: () => T | Promise<T>, timeoutMs = 5_000): Promise<NonNullable<T>> => { const end = Date.now() + timeoutMs; for (;;) { const value = await get(); if (value) return value; if (Date.now() >= end) throw new Error('Planner probe timed out.'); await new Promise((resolve) => setTimeout(resolve, 100)); } };
