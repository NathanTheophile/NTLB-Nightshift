import { spawn } from 'node:child_process';
import { lstat, mkdir, symlink, unlink } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import type { WorktreeHandle, WorktreeService, WorktreeSpec } from './contracts/WorktreeService';
import { candidateBranchForRunName, readableRunNameWithSuffix, readableRunSlug } from './RunNaming';

export interface GitCommandResult { stdout: string; stderr: string; exitCode: number; }
export interface GitCommandOptions {
  timeoutMs?: number;
  environment?: Readonly<Record<string, string>>;
}
export type GitCommand = (repositoryRoot: string, argumentsList: readonly string[], options?: GitCommandOptions) => Promise<GitCommandResult>;

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
    const storage = join(this.storageRoot, basename(repositoryRoot));
    await mkdir(storage, { recursive: true });
    const baseName = readableRunSlug(spec.title ?? spec.runId);
    const runName = await this.allocateRunName(repositoryRoot, storage, baseName);
    const branchName = candidateBranchForRunName(runName);
    const path = join(storage, runName);
    const result = await this.git(repositoryRoot, ['worktree', 'add', '--detach', path, baseResult.stdout.trim()]);
    if (result.exitCode !== 0) throw new Error(`Could not create isolated worktree: ${result.stderr.trim() || result.stdout.trim()}`);
    await linkSourceDependencies(repositoryRoot, path);
    return { path, baseSha: baseResult.stdout.trim(), branchName };
  }

  private async allocateRunName(repositoryRoot: string, storage: string, baseName: string): Promise<string> {
    for (let ordinal = 1; ordinal <= 9_999; ordinal += 1) {
      const runName = readableRunNameWithSuffix(baseName, ordinal);
      if (await pathExists(join(storage, runName))) continue;
      const branch = await this.git(repositoryRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${candidateBranchForRunName(runName)}`]);
      if (branch.exitCode === 1) return runName;
      if (branch.exitCode !== 0) throw new Error(`Could not inspect candidate branch availability for ${runName}.`);
    }
    throw new Error(`Could not allocate a readable Run name for ${baseName}.`);
  }

  public async inspect(path: string): Promise<WorktreeHandle | undefined> {
    const head = await this.git(path, ['rev-parse', '--verify', 'HEAD']);
    if (head.exitCode !== 0) return undefined;
    return { path, baseSha: head.stdout.trim(), branchName: 'detached' };
  }

  public async removeAfterEvidencePersisted(path: string): Promise<void> {
    await removeDependencyJunction(path);
    const commonDirectory = await this.git(path, ['rev-parse', '--git-common-dir']);
    if (commonDirectory.exitCode !== 0) throw new Error('Could not determine the source repository for this worktree.');
    const repositoryRoot = resolve(path, commonDirectory.stdout.trim(), '..');
    const result = await this.git(repositoryRoot, ['worktree', 'remove', '--force', path]);
    if (result.exitCode !== 0) throw new Error(`Could not remove worktree: ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

const linkSourceDependencies = async (repositoryRoot: string, worktreePath: string): Promise<void> => {
  const source = join(repositoryRoot, 'node_modules');
  if (!await isRealDirectory(source)) return;

  const destination = join(worktreePath, 'node_modules');
  if (await pathExists(destination)) throw new Error('Could not link workspace dependencies because the worktree already contains node_modules.');
  await symlink(source, destination, 'junction');
};

const removeDependencyJunction = async (worktreePath: string): Promise<void> => {
  const destination = join(worktreePath, 'node_modules');
  let entry;
  try { entry = await lstat(destination); } catch (error) { if (isMissing(error)) return; throw error; }
  if (!entry.isSymbolicLink()) throw new Error('Refusing to remove worktree because node_modules is not a dependency junction.');
  await unlink(destination);
};

const isRealDirectory = async (path: string): Promise<boolean> => {
  try { const entry = await lstat(path); return entry.isDirectory() && !entry.isSymbolicLink(); } catch (error) { if (isMissing(error)) return false; throw error; }
};
const pathExists = async (path: string): Promise<boolean> => {
  try { await lstat(path); return true; } catch (error) { if (isMissing(error)) return false; throw error; }
};
const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';

export const runGit: GitCommand = (repositoryRoot, argumentsList, options = {}) => new Promise((resolvePromise, reject) => {
  const child = spawn('git', ['-C', repositoryRoot, ...argumentsList], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...options.environment } });
  let stdout = ''; let stderr = '';
  let settled = false;
  let timingOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const settle = (result: GitCommandResult): void => {
    if (settled) return;
    settled = true;
    if (timeout) clearTimeout(timeout);
    resolvePromise(result);
  };
  timeout = options.timeoutMs === undefined ? undefined : setTimeout(() => {
    timingOut = true;
    void terminateProcessTree(child).finally(() => {
      settle({ stdout, stderr: `${stderr}${stderr ? '\n' : ''}Git command timed out after ${options.timeoutMs}ms.`, exitCode: -1 });
    });
  }, options.timeoutMs);
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; }); child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  child.once('error', (error) => {
    if (settled) return;
    if (timeout) clearTimeout(timeout);
    reject(error);
  });
  child.once('close', (exitCode) => { if (!timingOut) settle({ stdout, stderr, exitCode: exitCode ?? -1 }); });
});

const terminateProcessTree = async (child: ReturnType<typeof spawn>): Promise<void> => {
  if (child.pid === undefined) return;
  if (process.platform !== 'win32') {
    child.kill('SIGKILL');
    return;
  }
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
  const taskkill = spawn(`${systemRoot}\\System32\\taskkill.exe`, ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      taskkill.kill();
      resolve();
    }, 5_000);
    const complete = (): void => {
      clearTimeout(timeout);
      resolve();
    };
    taskkill.once('error', complete);
    taskkill.once('close', complete);
  });
};
