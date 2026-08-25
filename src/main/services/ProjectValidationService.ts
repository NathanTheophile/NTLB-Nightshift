import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ValidationStatus } from '@shared/domain/entities';

import type { RunRepository } from '../persistence/repositories/RunRepository';

const PROFILE_ID = 'node-package-scripts-v1';
const SCRIPT_ORDER = ['typecheck', 'lint', 'test', 'build'] as const;
const MAX_OUTPUT_BYTES = 64 * 1024;

interface PackageJson { scripts?: Record<string, unknown>; }
interface ValidationCommand { script: string; command: string; }

export class ProjectValidationService {
  public constructor(private readonly runs: RunRepository) {}

  public async validate(runId: string, worktreePath: string): Promise<ValidationStatus> {
    const commands = await resolveCommands(worktreePath);
    if (!commands.length) return 'not_configured';
    this.runs.setValidationStatus(runId, 'running'); this.runs.appendEvent(runId, 'validation_started', { profileId: PROFILE_ID, commandCount: commands.length });
    for (const spec of commands) {
      const evidence = this.runs.startValidationCommand(runId, PROFILE_ID, spec.command); this.runs.appendEvent(runId, 'validation_command_started', { profileId: PROFILE_ID, command: spec.command });
      const result = await executeScript(worktreePath, spec.script);
      const status = result.exitCode === 0 ? 'passed' : 'failed';
      this.runs.finishValidationCommand(evidence.id, status, result.exitCode, result.output, result.truncated);
      this.runs.appendEvent(runId, `validation_command_${status}`, { command: spec.command, exitCode: result.exitCode, outputTruncated: result.truncated });
      if (status === 'failed') { this.runs.setValidationStatus(runId, 'failed'); this.runs.appendEvent(runId, 'validation_failed', { command: spec.command, exitCode: result.exitCode }); return 'failed'; }
    }
    this.runs.setValidationStatus(runId, 'passed'); this.runs.appendEvent(runId, 'validation_passed', { profileId: PROFILE_ID }); return 'passed';
  }
}

const resolveCommands = async (worktreePath: string): Promise<ValidationCommand[]> => {
  try {
    const parsed = JSON.parse(await readFile(join(worktreePath, 'package.json'), 'utf8')) as PackageJson;
    const scripts = parsed.scripts;
    if (!scripts || typeof scripts !== 'object') return [];
    return SCRIPT_ORDER.filter((script) => typeof scripts[script] === 'string' && scripts[script].trim()).map((script) => ({ script, command: `npm run ${script}` }));
  } catch { return []; }
};

const executeScript = (workingDirectory: string, script: string): Promise<{ exitCode: number | null; output: string; truncated: boolean }> => new Promise((resolve) => {
  const executable = process.platform === 'win32' ? 'cmd.exe' : 'npm';
  const arguments_ = process.platform === 'win32' ? ['/d', '/s', '/c', `npm run ${script}`] : ['run', script];
  const child = spawn(executable, arguments_, { cwd: workingDirectory, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; let bytes = 0; let truncated = false;
  const append = (chunk: string): void => { const chunkBytes = Buffer.byteLength(chunk); const remaining = MAX_OUTPUT_BYTES - bytes; if (remaining > 0) output += Buffer.from(chunk).subarray(0, remaining).toString('utf8'); bytes += chunkBytes; truncated ||= bytes > MAX_OUTPUT_BYTES; };
  child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8'); child.stdout?.on('data', append); child.stderr?.on('data', append);
  child.once('error', (error) => { append(error.message); resolve({ exitCode: null, output, truncated }); });
  child.once('close', (exitCode) => resolve({ exitCode, output, truncated }));
});
