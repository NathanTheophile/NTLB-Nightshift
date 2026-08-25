import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

import { DatabaseService } from '../src/main/persistence/DatabaseService';
import { RunRepository } from '../src/main/persistence/repositories/RunRepository';
import { WorkspaceRepository } from '../src/main/persistence/repositories/WorkspaceRepository';
import { PlannerTaskRepository } from '../src/main/persistence/repositories/PlannerTaskRepository';
import { GitWorktreeService } from '../src/main/services/GitWorktreeService';
import { RunReviewService } from '../src/main/services/RunReviewService';

const exec = promisify(execFileCallback);

describe('RunReviewService', () => {
  it('reviews changed files from the recorded base after the source repository moves', async () => {
    const fixture = await setup();
    try {
      await writeFile(join(fixture.worktree, 'modified.txt'), 'changed\n'); await rm(join(fixture.worktree, 'deleted.txt'));
      await exec('git', ['-C', fixture.worktree, 'mv', 'renamed.txt', 'moved.txt']); await writeFile(join(fixture.worktree, 'new.txt'), 'untracked\n');
      await writeFile(join(fixture.repository, 'after.txt'), 'main moved\n'); await exec('git', ['-C', fixture.repository, 'add', '.']); await exec('git', ['-C', fixture.repository, 'commit', '-m', 'move main']);
      const review = await fixture.service.inspect(fixture.run.id);
      expect(review.changedFiles.map((file) => file.kind)).toEqual(expect.arrayContaining(['modified', 'deleted', 'renamed', 'untracked'])); expect(review.changedFiles.find((file) => file.kind === 'renamed')?.previousPath).toBeTruthy();
      expect((await fixture.service.fileDiff(fixture.run.id, 'modified.txt')).content).toContain('-base');
      expect((await fixture.service.fileDiff(fixture.run.id, 'new.txt')).content).toContain('+++ b/new.txt');
      expect(review.batchSteps.map((step) => step.prompt)).toEqual(['First evidence']);
    } finally { await fixture.dispose(); }
  });

  it('handles binary files, missing worktrees, and missing base commits without reading unsafe content', async () => {
    const fixture = await setup();
    try {
      await writeFile(join(fixture.worktree, 'binary.bin'), Buffer.from([0, 1, 2]));
      const binary = await fixture.service.fileDiff(fixture.run.id, 'binary.bin'); expect(binary.isBinary).toBe(true); expect(binary.content).toBeNull();
      fixture.runRepository.setPreparation(fixture.run.id, 'deadbeef', fixture.worktree);
      expect((await fixture.service.inspect(fixture.run.id)).warnings.join(' ')).toContain('unavailable');
      fixture.runRepository.setPreparation(fixture.run.id, fixture.base, join(fixture.worktree, 'missing'));
      expect((await fixture.service.inspect(fixture.run.id)).warnings.join(' ')).toContain('missing or invalid');
    } finally { await fixture.dispose(); }
  });

  it('rejects worktrees from another repository for review, export, and opening', async () => {
    const fixture = await setup();
    try {
      const unrelated = join(fixture.root, 'unrelated');
      await exec('git', ['init', unrelated]); await exec('git', ['-C', unrelated, 'config', 'user.email', 'test@nightshift.local']); await exec('git', ['-C', unrelated, 'config', 'user.name', 'NightShift Test']);
      await writeFile(join(unrelated, 'foreign.txt'), 'foreign\n'); await exec('git', ['-C', unrelated, 'add', '.']); await exec('git', ['-C', unrelated, 'commit', '-m', 'foreign']);
      fixture.runRepository.setPreparation(fixture.run.id, fixture.base, unrelated);
      expect((await fixture.service.inspect(fixture.run.id)).warnings.join(' ')).toContain('missing or invalid');
      await fixture.service.exportTo(fixture.run.id, 'bundle', join(fixture.root, 'foreign.zip'));
      expect((await readFile(join(fixture.root, 'foreign.zip'))).toString('utf8')).not.toContain('foreign.txt');
      await expect(fixture.service.resolveValidWorktree(fixture.run.id)).rejects.toThrow('valid persisted worktree');
    } finally { await fixture.dispose(); }
  });

  it('probes large files without making them diffable', async () => {
    const fixture = await setup();
    try {
      await writeFile(join(fixture.worktree, 'large.bin'), Buffer.concat([Buffer.from([0]), Buffer.alloc(9 * 1024 * 1024)]));
      const file = (await fixture.service.inspect(fixture.run.id)).changedFiles.find((item) => item.path === 'large.bin');
      expect(file).toMatchObject({ isBinary: true, diffAvailable: false, sizeBytes: 9 * 1024 * 1024 + 1 });
    } finally { await fixture.dispose(); }
  });

  it('exports bounded evidence only: review files, patch and safe untracked content', async () => {
    const fixture = await setup();
    try {
      await writeFile(join(fixture.worktree, 'modified.txt'), 'changed\n'); await writeFile(join(fixture.worktree, 'new.txt'), 'untracked\n');
      const markdownPath = join(fixture.root, 'review.md'); const jsonPath = join(fixture.root, 'review.json'); const zipPath = join(fixture.root, 'review.zip');
      await fixture.service.exportTo(fixture.run.id, 'markdown', markdownPath); await fixture.service.exportTo(fixture.run.id, 'json', jsonPath); await fixture.service.exportTo(fixture.run.id, 'bundle', zipPath);
      expect(await readFile(markdownPath, 'utf8')).toContain('NightShift Run Review'); expect((JSON.parse(await readFile(jsonPath, 'utf8')) as { schemaVersion: number }).schemaVersion).toBe(1);
      const bundle = (await readFile(zipPath)).toString('utf8'); expect(bundle).toContain('run-review.md'); expect(bundle).toContain('changes.patch'); expect(bundle).toContain('untracked/new.txt'); expect(bundle).not.toContain('.git/'); expect(bundle).not.toContain('deleted.txt');
    } finally { await fixture.dispose(); }
  });
});

const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), 'nightshift-review-')); const repository = join(root, 'repository'); const storage = join(root, 'worktrees');
  await exec('git', ['init', repository]); await exec('git', ['-C', repository, 'config', 'user.email', 'test@nightshift.local']); await exec('git', ['-C', repository, 'config', 'user.name', 'NightShift Test']);
  await Promise.all(['modified.txt', 'deleted.txt', 'renamed.txt'].map((name) => writeFile(join(repository, name), 'base\n'))); await exec('git', ['-C', repository, 'add', '.']); await exec('git', ['-C', repository, 'commit', '-m', 'base']); const base = (await exec('git', ['-C', repository, 'rev-parse', 'HEAD'])).stdout.trim();
  const database = new DatabaseService(':memory:'); const workspaces = new WorkspaceRepository(database); const tasks = new PlannerTaskRepository(database); const workspace = workspaces.addOrTouch(repository, 'repository', true); const task = tasks.create({ workspaceId: workspace.id, prompt: 'Review evidence', requestedAgentId: null, requestedModelId: null, priority: 1, executionMode: 'sequential_batch', batchSteps: ['First evidence'] }); const runRepository = new RunRepository(database); const run = runRepository.create({ taskId: task.id, workspaceId: workspace.id, resolvedAgentId: 'agent', resolvedModelId: 'model', executionMode: 'sequential_batch' }); const handle = await new GitWorktreeService(storage).createForRun({ runId: run.id, repositoryRoot: repository, baseSha: base }); runRepository.setPreparation(run.id, base, handle.path); runRepository.createBatchSteps(run.id, ['First evidence']);
  return { root, repository, worktree: handle.path, base, run: runRepository.findRequired(run.id), runRepository, service: new RunReviewService(runRepository, workspaces), dispose: async () => { database.close(); await rm(root, { recursive: true, force: true }); } };
};
