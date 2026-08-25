import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import type { WorktreeHandle, WorktreeService, WorktreeSpec } from './contracts/WorktreeService';

export interface GitCommandResult { stdout: string; stderr: string; exitCode: number; }
export type GitCommand = (repositoryRoot: string, argumentsList: readonly string[]) => Promise<GitCommandResult>;

export class GitWorktreeService implements WorktreeService {
  public constructor(private readonly storageRoot: string, private readonly git: GitCommand = runGit) {}

  public async createForRun(spec: WorktreeSpec): Promise<WorktreeHandle> {
    const repositoryRoot = resolve(spec.repositoryRoot);
    const rootResult = await this.git(repositoryRoot, ['rev-parse', '--show-toplevel']);
    if (rootResult.exitCode !== 0 || resolve(rootResult.stdout.trim()) !== repositoryRoot) {
      throw new Error('Planner write-capable runs require the selected workspace to be a Git repository root.');
    }
    const baseResult = await this.git(repositoryRoot, ['rev-parse', '--verify', `${spec.baseSha}^{commit}`]);
    if (baseResult.exitCode !== 0) throw new Error(`Git base ${spec.baseSha} is not available.`);
    const branchName = `nightshift/run-${spec.runId}`;
    const path = join(this.storageRoot, basename(repositoryRoot), spec.runId);
    await mkdir(this.storageRoot, { recursive: true });
    const result = await this.git(repositoryRoot, ['worktree', 'add', '--detach', path, baseResult.stdout.trim()]);
    if (result.exitCode !== 0) throw new Error(`Could not create isolated worktree: ${result.stderr.trim() || result.stdout.trim()}`);
    return { path, baseSha: baseResult.stdout.trim(), branchName };
  }

  public async inspect(path: string): Promise<WorktreeHandle | undefined> {
    const head = await this.git(path, ['rev-parse', '--verify', 'HEAD']);
    if (head.exitCode !== 0) return undefined;
    return { path, baseSha: head.stdout.trim(), branchName: 'detached' };
  }

  public async removeAfterEvidencePersisted(path: string): Promise<void> {
    const result = await this.git(path, ['worktree', 'remove', '--force', path]);
    if (result.exitCode !== 0) throw new Error(`Could not remove worktree: ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

export const runGit: GitCommand = (repositoryRoot, argumentsList) => new Promise((resolvePromise, reject) => {
  const child = spawn('git', ['-C', repositoryRoot, ...argumentsList], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; }); child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  child.once('error', reject); child.once('close', (exitCode) => resolvePromise({ stdout, stderr, exitCode: exitCode ?? -1 }));
});
