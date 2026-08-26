import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { GitWorktreeService } from '../src/main/services/GitWorktreeService';

const exec = promisify(execFile);

describe('GitWorktreeService readable names', () => {
  it('uses minimal numeric suffixes when the preferred readable name is already in use', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nightshift-worktree-naming-')); const repository = join(root, 'repository'); const storage = join(root, 'worktrees');
    try {
      await exec('git', ['init', repository]); await exec('git', ['-C', repository, 'config', 'user.email', 'test@nightshift.local']); await exec('git', ['-C', repository, 'config', 'user.name', 'NightShift Test']); await writeFile(join(repository, 'README.md'), 'base\n'); await exec('git', ['-C', repository, 'add', '.']); await exec('git', ['-C', repository, 'commit', '-m', 'base']);
      const baseSha = (await exec('git', ['-C', repository, 'rev-parse', 'HEAD'])).stdout.trim(); const service = new GitWorktreeService(storage);
      const first = await service.createForRun({ runId: 'one', title: 'Improve Run observability', repositoryRoot: repository, baseSha });
      const second = await service.createForRun({ runId: 'two', title: 'Improve Run observability', repositoryRoot: repository, baseSha });
      expect(basename(first.path)).toBe('improve-run-observability'); expect(basename(second.path)).toBe('improve-run-observability-2');
      expect(first.branchName).toBe('nightshift/run/improve-run-observability'); expect(second.branchName).toBe('nightshift/run/improve-run-observability-2');
      await service.removeAfterEvidencePersisted(second.path); await service.removeAfterEvidencePersisted(first.path);
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 3 }); }
  });
});

describe.skipIf(process.platform !== 'win32')('GitWorktreeService dependency junctions', () => {
  it('shares source dependencies and removes only the junction during worktree cleanup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nightshift-worktree-junction-')); const repository = join(root, 'repository'); const sourceDependencies = join(repository, 'node_modules'); const sentinel = join(sourceDependencies, 'nightshift-sentinel.txt'); const storage = join(root, 'worktrees');
    try {
      await exec('git', ['init', repository]); await exec('git', ['-C', repository, 'config', 'user.email', 'test@nightshift.local']); await exec('git', ['-C', repository, 'config', 'user.name', 'NightShift Test']);
      await writeFile(join(repository, '.gitignore'), 'node_modules/\n'); await writeFile(join(repository, 'README.md'), 'base\n'); await mkdir(sourceDependencies); await writeFile(sentinel, 'source-owned-sentinel\n'); await exec('git', ['-C', repository, 'add', '.']); await exec('git', ['-C', repository, 'commit', '-m', 'base']);
      const baseSha = (await exec('git', ['-C', repository, 'rev-parse', 'HEAD'])).stdout.trim(); const service = new GitWorktreeService(storage); const worktree = await service.createForRun({ runId: 'junction-test', title: 'Readable dependency junction', repositoryRoot: repository, baseSha }); const worktreeDependencies = join(worktree.path, 'node_modules');

      expect(basename(worktree.path)).toBe('readable-dependency-junction'); expect(worktree.branchName).toBe('nightshift/run/readable-dependency-junction');
      expect(await readFile(join(worktreeDependencies, 'nightshift-sentinel.txt'), 'utf8')).toBe('source-owned-sentinel\n'); expect(await realpath(worktreeDependencies)).toBe(await realpath(sourceDependencies)); expect((await exec('git', ['-C', worktree.path, 'status', '--porcelain=v1'])).stdout).not.toContain('node_modules');

      await service.removeAfterEvidencePersisted(worktree.path);

      await expect(lstat(worktree.path)).rejects.toMatchObject({ code: 'ENOENT' }); expect(await readFile(sentinel, 'utf8')).toBe('source-owned-sentinel\n'); expect(await realpath(sourceDependencies)).toBe(await realpath(sourceDependencies));
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 3 }); }
  });
});
