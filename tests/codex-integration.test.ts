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
import { CodexAdapter } from '../src/main/services/agents/CodexAdapter';
import { FccRuntimeManager } from '../src/main/services/runtime/FccRuntimeManager';
import { LocalFccGateway } from '../src/main/services/runtime/LocalFccGateway';

const exec = promisify(execFile);
const probeEnabled = process.env.NIGHTSHIFT_RUN_FCC_PROBE === '1';
const timeoutMs = 180_000;
const model = 'nvidia_nim/nvidia/nemotron-3-super-120b-a12b';

describe.skipIf(!probeEnabled)('CodexAdapter real FCC integration', () => {
  it('keeps the source checkout untouched and completes a structured isolated Run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nightshift-codex-probe-'));
    const repository = join(root, 'source');
    const database = new DatabaseService(':memory:');
    const supervisor = new WindowsProcessSupervisor();
    const gateway = new LocalFccGateway(new FccRuntimeManager({ supervisor }));
    try {
      await exec('git', ['init', repository]);
      await exec('git', ['-C', repository, 'config', 'user.email', 'probe@nightshift.local']);
      await exec('git', ['-C', repository, 'config', 'user.name', 'NightShift Probe']);
      await writeFile(join(repository, 'README.md'), 'base\n');
      await exec('git', ['-C', repository, 'add', '.']); await exec('git', ['-C', repository, 'commit', '-m', 'base']);
      const workspace = new WorkspaceRepository(database).addOrTouch(repository, 'source', true);
      const tasks = new PlannerTaskRepository(database); const runs = new RunRepository(database);
      const adapter = new CodexAdapter(supervisor, gateway);
      const service = new RunService(runs, tasks, new WorkspaceRepository(database), new GitWorktreeService(join(root, 'worktrees')), new Map([[adapter.id, adapter]]), { agentId: adapter.id, modelId: model, timeoutMs });
      tasks.create({ workspaceId: workspace.id, prompt: 'Create NIGHTSHIFT_AGENT_PROBE.txt in the repository root. Its complete contents must be exactly NIGHTSHIFT_AGENT_PROBE_OK. Do not modify any other file. Then report completion.', requestedAgentId: 'codex', requestedModelId: model, priority: 1 });
      service.schedule();
      const run = await waitFor(() => service.list(workspace.id)[0], 5_000);
      const completed = await waitFor(async () => { const value = await service.find(run.id); return value?.status === 'completed' ? value : undefined; }, timeoutMs + 15_000);
      expect(await readFile(join(repository, 'README.md'), 'utf8')).toBe('base\n');
      await expect(readFile(join(repository, 'NIGHTSHIFT_AGENT_PROBE.txt'), 'utf8')).rejects.toThrow();
      expect(await readFile(join(completed.worktreePath!, 'NIGHTSHIFT_AGENT_PROBE.txt'), 'utf8')).toBe('NIGHTSHIFT_AGENT_PROBE_OK');
      expect(completed.externalSessionId).toBeTruthy();
      expect(service.events(completed.id, 'raw_protocol').events.some(({ eventType }) => eventType === 'agent_protocol')).toBe(true);
      expect(adapter.capabilities().cancel).toBe(true);
    } finally { await gateway.stopOwnedProcess(); database.close(); await rm(root, { recursive: true, force: true }); }
  }, timeoutMs + 30_000);
});

const waitFor = async <T>(get: () => T | Promise<T>, limit: number): Promise<NonNullable<T>> => {
  const deadline = Date.now() + limit;
  for (;;) { const value = await get(); if (value) return value; if (Date.now() >= deadline) throw new Error('Codex integration probe timed out.'); await new Promise((resolve) => setTimeout(resolve, 50)); }
};
