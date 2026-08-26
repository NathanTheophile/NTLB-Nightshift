import { runGit } from './GitWorktreeService';

export class DelegatedWorktreeCheckpoint {
  public constructor(public readonly treeId: string) {}

  public static async capture(worktreePath: string): Promise<DelegatedWorktreeCheckpoint> {
    const staged = await runGit(worktreePath, ['add', '--all']);
    if (staged.exitCode !== 0) throw new Error(gitFailure('Could not capture delegated checkpoint.', staged));
    const tree = await runGit(worktreePath, ['write-tree']);
    if (tree.exitCode !== 0 || !tree.stdout.trim()) throw new Error(gitFailure('Could not write delegated checkpoint.', tree));
    return new DelegatedWorktreeCheckpoint(tree.stdout.trim());
  }

  public async restore(worktreePath: string): Promise<void> {
    const indexed = await runGit(worktreePath, ['read-tree', '--reset', this.treeId]);
    if (indexed.exitCode !== 0) throw new Error(gitFailure('Could not restore delegated checkpoint index.', indexed));
    const cleaned = await runGit(worktreePath, ['clean', '-fd']);
    if (cleaned.exitCode !== 0) throw new Error(gitFailure('Could not clear rejected delegated changes.', cleaned));
    const restored = await runGit(worktreePath, ['checkout-index', '--all', '--force']);
    if (restored.exitCode !== 0) throw new Error(gitFailure('Could not restore delegated checkpoint files.', restored));
  }
}

const gitFailure = (prefix: string, result: { stdout: string; stderr: string }): string => `${prefix} ${result.stderr.trim() || result.stdout.trim() || 'Git returned an error.'}`;
