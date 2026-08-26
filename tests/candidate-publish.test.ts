import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { DatabaseService } from '../src/main/persistence/DatabaseService';
import { PlannerTaskRepository } from '../src/main/persistence/repositories/PlannerTaskRepository';
import { RunRepository } from '../src/main/persistence/repositories/RunRepository';
import { WorkspaceRepository } from '../src/main/persistence/repositories/WorkspaceRepository';
import { GitWorktreeService } from '../src/main/services/GitWorktreeService';
import { RunService } from '../src/main/services/RunService';
import type { AgentAdapter, AgentExecutionHandle, RunStartSpec } from '../src/main/services/contracts/AgentAdapter';
import type { AgentCapabilities, AgentDescriptor } from '../src/shared/domain/entities';

const exec = promisify(execFile);
const capabilities: AgentCapabilities = { interactive: false, headless: true, structuredEvents: true, rawPty: false, resume: false, modelOverride: true, cancel: true, workingDirectory: true, imageInput: false, subagents: false, plannerValidated: true, workerValidated: false, renderMode: 'structured' };

describe('candidate publishing and follow-up runs', () => {
  it('commits tracked and untracked changes once, pushes only its candidate branch, and rejects no-change Runs', async () => {
    const fixture = await setup();
    try {
      const source = await fixture.completedRun(true);
      const [published, concurrent] = await Promise.all([fixture.service.publishCandidate(source.id), fixture.service.publishCandidate(source.id)]);
      expect(published.candidatePublishState).toBe('published');
      expect(published.candidateBranchName).toBe(`nightshift/run/${basename(source.worktreePath ?? '')}`);
      expect(published.candidateCommitSha).toMatch(/^[0-9a-f]{40}$/);
      expect(concurrent.candidateCommitSha).toBe(published.candidateCommitSha);
      const remote = await exec('git', ['--git-dir', fixture.remote, 'rev-parse', `refs/heads/${published.candidateBranchName}`]);
      expect(remote.stdout.trim()).toBe(published.candidateCommitSha);
      const retry = await fixture.service.publishCandidate(source.id);
      expect(retry.candidateCommitSha).toBe(published.candidateCommitSha);
      const clean = await fixture.completedRun(false);
      await expect(fixture.service.publishCandidate(clean.id)).rejects.toThrow('no changes');
    } finally { await fixture.dispose(); }
  });

  it('refuses an incompatible pre-existing remote candidate branch', async () => {
    const fixture = await setup();
    try {
      const source = await fixture.completedRun(true); const branch = `nightshift/run/${basename(source.worktreePath ?? '')}`;
      await exec('git', ['-C', fixture.repository, 'push', 'origin', `HEAD:refs/heads/${branch}`]);
      await expect(fixture.service.publishCandidate(source.id)).rejects.toThrow('incompatible commit');
      expect((await fixture.service.find(source.id))?.candidatePublishState).toBe('failed');
    } finally { await fixture.dispose(); }
  });

  it('recovers candidate materialization after a local branch or commit is left behind', async () => {
    const fixture = await setup();
    try {
      const afterBranch = await fixture.completedRun(true); const branch = `nightshift/run/${basename(afterBranch.worktreePath ?? '')}`;
      await exec('git', ['-C', (await fixture.service.find(afterBranch.id))?.worktreePath ?? '', 'switch', '-c', branch]);
      const recoveredBranch = await fixture.service.publishCandidate(afterBranch.id);
      expect(recoveredBranch.candidatePublishState).toBe('published');

      const afterCommit = await fixture.completedRun(true); const committedWorktree = (await fixture.service.find(afterCommit.id))?.worktreePath ?? ''; const committedBranch = `nightshift/run/${basename(committedWorktree)}`;
      await exec('git', ['-C', committedWorktree, 'switch', '-c', committedBranch]); await exec('git', ['-C', committedWorktree, 'add', '-A']); await exec('git', ['-C', committedWorktree, 'commit', '-m', `NightShift candidate: ${afterCommit.id}`]);
      const recoveredCommit = await fixture.service.publishCandidate(afterCommit.id);
      expect(recoveredCommit.candidatePublishState).toBe('published'); expect(recoveredCommit.candidateBranchName).toBe(committedBranch);
    } finally { await fixture.dispose(); }
  });

  it('bases a fresh follow-up invocation on the published candidate even after the workspace HEAD moves', async () => {
    const fixture = await setup();
    try {
      const source = await fixture.completedRun(true); const published = await fixture.service.publishCandidate(source.id);
      await writeFile(join(fixture.repository, 'base.txt'), 'dev moved\n'); await exec('git', ['-C', fixture.repository, 'add', 'base.txt']); await exec('git', ['-C', fixture.repository, 'commit', '-m', 'move dev']);
      const followUp = await fixture.service.createFollowUp(source.id, 'Correct the candidate.');
      const completed = await waitFor(() => fixture.service.find(followUp.id).then((run) => run?.status === 'completed' ? run : undefined));
      expect(completed.sourceRunId).toBe(source.id); expect(completed.baseSha).toBe(published.candidateCommitSha); expect(completed.worktreePath).not.toBe(source.worktreePath); expect(fixture.adapter.starts).toBe(1);
    } finally { await fixture.dispose(); }
  });

  it('runs a sequential source follow-up once as a fresh single-agent corrective Run', async () => {
    const fixture = await setup();
    try {
      const source = await fixture.completedRun(true, 'sequential_batch'); const published = await fixture.service.publishCandidate(source.id);
      const followUp = await fixture.service.createFollowUp(source.id, 'Correct the candidate.');
      const completed = await waitFor(() => fixture.service.find(followUp.id).then((run) => run?.status === 'completed' ? run : undefined));
      expect(completed).toMatchObject({ executionMode: 'single_agent', sourceRunId: source.id, baseSha: published.candidateCommitSha });
      expect(fixture.service.batchSteps(completed.id)).toEqual([]); expect(fixture.adapter.starts).toBe(1);
      expect(fixture.tasks.findById(source.taskId)?.status).toBe('completed');
    } finally { await fixture.dispose(); }
  });
});

const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), 'nightshift-candidate-')); const repository = join(root, 'repo'); const remote = join(root, 'remote.git'); const database = new DatabaseService(':memory:');
  await exec('git', ['init', repository]); await exec('git', ['-C', repository, 'config', 'user.email', 'test@nightshift.local']); await exec('git', ['-C', repository, 'config', 'user.name', 'NightShift Test']); await writeFile(join(repository, 'base.txt'), 'base\n'); await exec('git', ['-C', repository, 'add', '.']); await exec('git', ['-C', repository, 'commit', '-m', 'base']); await exec('git', ['init', '--bare', remote]); await exec('git', ['-C', repository, 'remote', 'add', 'origin', remote]);
  const workspaces = new WorkspaceRepository(database); const tasks = new PlannerTaskRepository(database); const runs = new RunRepository(database); const workspace = workspaces.addOrTouch(repository, 'repo', true); const adapter = new FollowUpAdapter(); const service = new RunService(runs, tasks, workspaces, new GitWorktreeService(join(root, 'worktrees')), new Map([[adapter.id, adapter]]), { agentId: adapter.id, modelId: 'model', timeoutMs: 2_000 });
  const completedRun = async (changes: boolean, executionMode: 'single_agent' | 'sequential_batch' = 'single_agent') => {
    const task = tasks.create({ workspaceId: workspace.id, prompt: 'Change files.', requestedAgentId: adapter.id, requestedModelId: 'model', priority: 1, executionMode, batchSteps: executionMode === 'sequential_batch' ? ['First step', 'Second step'] : [] }); const run = runs.create({ taskId: task.id, workspaceId: workspace.id, resolvedAgentId: adapter.id, resolvedModelId: 'model', executionMode }); const base = (await exec('git', ['-C', repository, 'rev-parse', 'HEAD'])).stdout.trim(); const worktree = await new GitWorktreeService(join(root, 'worktrees')).createForRun({ runId: run.id, title: task.title, repositoryRoot: repository, baseSha: base }); runs.setPreparation(run.id, base, worktree.path);
    if (changes) { await writeFile(join(worktree.path, 'base.txt'), 'tracked change\n'); await writeFile(join(worktree.path, 'untracked.txt'), 'untracked\n'); }
    tasks.setStatus(task.id, 'completed'); return runs.setStatus(run.id, 'completed');
  };
  return { repository, remote, service, adapter, tasks, completedRun, dispose: async () => { database.close(); await rm(root, { recursive: true, force: true }); } };
};

class FollowUpAdapter implements AgentAdapter {
  public readonly id = 'test-agent'; public starts = 0; public capabilities = (): AgentCapabilities => capabilities;
  public detect = (): Promise<AgentDescriptor> => Promise.resolve({ id: this.id, displayName: 'Test', fccLauncher: 'test', installed: true, launchable: true, version: null, capabilities, lastValidatedAt: null });
  public async startRun(spec: RunStartSpec): Promise<AgentExecutionHandle> { this.starts += 1; await writeFile(join(spec.workingDirectory, 'follow-up.txt'), 'fresh invocation\n'); return { handleId: 'follow-up', externalSessionId: 'fresh-session', events: [], completion: Promise.resolve({ handleId: 'follow-up', succeeded: true, failureReason: null, exitCode: 0, signal: null, externalSessionId: 'fresh-session', events: [], terminalEvent: null, stderr: '' }) }; }
  public startWorker(): Promise<AgentExecutionHandle> { return Promise.reject(new Error('not used')); }
  public cancel(): Promise<void> { return Promise.resolve(); }
}

const waitFor = async <T>(get: () => T | Promise<T>): Promise<NonNullable<T>> => { const until = Date.now() + 2_000; for (;;) { const value = await get(); if (value) return value; if (Date.now() > until) throw new Error('Timed out.'); await new Promise((resolve) => setTimeout(resolve, 10)); } };
