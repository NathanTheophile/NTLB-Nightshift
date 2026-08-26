import { randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

import type { ValidationStatus } from '@shared/domain/entities';

import type { RunRepository } from '../persistence/repositories/RunRepository';
import type { ProcessSupervisor } from './contracts/ProcessSupervisor';
import { runGit } from './GitWorktreeService';

const PROFILE_ID = 'node-package-scripts-v1';
const SCRIPT_ORDER = ['typecheck', 'lint', 'test', 'build'] as const;
const MAX_OUTPUT_BYTES = 64 * 1024;
const LIGHTWEIGHT_EXTENSIONS = new Set(['.md', '.txt', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.pdf']);
export const SOURCE_DEPENDENCIES_UNAVAILABLE = 'Workspace dependencies are unavailable. Install project dependencies in the source workspace before running autonomous validation.';

interface PackageJson { scripts?: Record<string, unknown>; }
interface ValidationCommand { script: string | null; command: string; }
export interface ValidationExecutionOptions { deadline: number; attemptId?: string; isCancellationRequested: () => boolean; onProcessStarted?: (cancel: () => Promise<void>) => void; onProcessFinished?: () => void; }

export class ProjectValidationService {
  public constructor(private readonly runs: RunRepository, private readonly supervisor: ProcessSupervisor) {}

  public async validate(runId: string, worktreePath: string, options: ValidationExecutionOptions): Promise<ValidationStatus> {
    const commands = await resolveCommands(worktreePath);
    if (!commands.length) return 'not_configured';
    this.runs.setValidationStatus(runId, 'running'); this.runs.appendEvent(runId, 'validation_started', { profileId: PROFILE_ID, commandCount: commands.length });
    for (const spec of commands) {
      if (options.isCancellationRequested()) return this.interrupt(runId, 'cancelled');
      if (Date.now() >= options.deadline) return this.interrupt(runId, 'timed_out');
      const evidence = this.runs.startValidationCommand(runId, PROFILE_ID, spec.command, options.attemptId ?? null); this.runs.appendEvent(runId, 'validation_command_started', { profileId: PROFILE_ID, command: spec.command, attemptId: options.attemptId ?? null });
      const result = await this.executeCommand(runId, worktreePath, spec, options);
      if (result.interruption) {
        this.runs.finishValidationCommand(evidence.id, 'interrupted', result.exitCode, result.output, result.truncated);
        this.runs.appendEvent(runId, 'validation_command_interrupted', { command: spec.command, reason: result.interruption });
        return this.interrupt(runId, result.interruption);
      }
      const status = result.exitCode === 0 ? 'passed' : 'failed';
      this.runs.finishValidationCommand(evidence.id, status, result.exitCode, result.output, result.truncated);
      this.runs.appendEvent(runId, `validation_command_${status}`, { command: spec.command, exitCode: result.exitCode, outputTruncated: result.truncated });
      if (status === 'failed') { this.runs.setValidationStatus(runId, 'failed'); this.runs.appendEvent(runId, 'validation_failed', { command: spec.command, exitCode: result.exitCode }); return 'failed'; }
    }
    this.runs.setValidationStatus(runId, 'passed'); this.runs.appendEvent(runId, 'validation_passed', { profileId: PROFILE_ID }); return 'passed';
  }

  private interrupt(runId: string, reason: 'cancelled' | 'timed_out'): ValidationStatus {
    this.runs.setValidationStatus(runId, 'interrupted'); this.runs.appendEvent(runId, 'validation_interrupted', { reason }); return 'interrupted';
  }

  private async executeCommand(runId: string, workingDirectory: string, spec: ValidationCommand, options: ValidationExecutionOptions): Promise<{ exitCode: number | null; output: string; truncated: boolean; interruption: 'cancelled' | 'timed_out' | null }> {
    const executionId = `validation-${runId}-${randomUUID()}`;
    const executablePath = spec.script === null ? 'git' : process.platform === 'win32' ? 'cmd.exe' : 'npm';
    const arguments_ = spec.script === null ? ['diff', '--check'] : process.platform === 'win32' ? ['/d', '/s', '/c', `npm run ${spec.script}`] : ['run', spec.script];
    await this.supervisor.start({ executionId, executablePath, arguments: arguments_, workingDirectory, environment: stringEnvironment(process.env) });
    options.onProcessStarted?.(() => this.supervisor.cancelOwnedTree(executionId));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const completion = this.supervisor.waitForCompletion(executionId); const remaining = Math.max(0, options.deadline - Date.now());
      const timedOut = new Promise<'timed_out'>((resolve) => { timer = setTimeout(() => resolve('timed_out'), remaining); }); const result = await Promise.race([completion, timedOut]);
      if (result === 'timed_out') { await this.supervisor.cancelOwnedTree(executionId); const stopped = await completion; return outputResult(stopped.exitCode, stopped.stdout, stopped.stderr, 'timed_out'); }
      return outputResult(result.exitCode, result.stdout, result.stderr, options.isCancellationRequested() ? 'cancelled' : null);
    } finally { if (timer) clearTimeout(timer); options.onProcessFinished?.(); }
  }
}

export const assertNodeValidationDependencies = async (repositoryRoot: string): Promise<void> => {
  if (!(await resolveCommands(repositoryRoot)).length) return;
  try {
    const dependencies = await lstat(join(repositoryRoot, 'node_modules'));
    if (dependencies.isDirectory() && !dependencies.isSymbolicLink()) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  throw new Error(SOURCE_DEPENDENCIES_UNAVAILABLE);
};

const resolveCommands = async (worktreePath: string): Promise<ValidationCommand[]> => {
  try {
    const parsed = JSON.parse(await readFile(join(worktreePath, 'package.json'), 'utf8')) as PackageJson; const scripts = parsed.scripts;
    const npmCommands = scripts && typeof scripts === 'object' ? SCRIPT_ORDER.filter((script) => typeof scripts[script] === 'string' && scripts[script].trim()).map((script) => ({ script, command: `npm run ${script}` })) : [];
    if (!npmCommands.length) return [];
    const changedPaths = await resolveChangedPaths(worktreePath);
    if (changedPaths?.length && changedPaths.every(isLightweightPath)) return [{ script: null, command: 'git diff --check' }];
    return npmCommands;
  } catch { return []; }
};
const resolveChangedPaths = async (worktreePath: string): Promise<string[] | null> => {
  const status = await runGit(worktreePath, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (status.exitCode !== 0) return null;
  return status.stdout.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    const path = line.slice(3).trim();
    if (!path) return [];
    const rename = path.split(' -> ');
    return rename.length === 2 ? rename : [path];
  });
};
const isLightweightPath = (path: string): boolean => LIGHTWEIGHT_EXTENSIONS.has(extname(path.replace(/\\/g, '/')).toLowerCase());
const outputResult = (exitCode: number | null, stdout: string, stderr: string, interruption: 'cancelled' | 'timed_out' | null) => {
  const output = `${stdout}${stderr}`; const bytes = Buffer.byteLength(output); return { exitCode, output: bytes > MAX_OUTPUT_BYTES ? Buffer.from(output).subarray(0, MAX_OUTPUT_BYTES).toString('utf8') : output, truncated: bytes > MAX_OUTPUT_BYTES, interruption };
};
const stringEnvironment = (environment: NodeJS.ProcessEnv): Readonly<Record<string, string>> => Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined));
