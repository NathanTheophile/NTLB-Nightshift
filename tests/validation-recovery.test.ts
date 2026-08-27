import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it, vi } from 'vitest';

import { DatabaseService } from '../src/main/persistence/DatabaseService';
import { PlannerTaskRepository } from '../src/main/persistence/repositories/PlannerTaskRepository';
import { RunRepository } from '../src/main/persistence/repositories/RunRepository';
import { WorkspaceRepository } from '../src/main/persistence/repositories/WorkspaceRepository';
import { ProjectValidationService } from '../src/main/services/ProjectValidationService';
import { RunService } from '../src/main/services/RunService';
import type { ProcessSupervisor, SupervisedProcessResult, SupervisedProcessSnapshot, SupervisedProcessSpec } from '../src/main/services/contracts/ProcessSupervisor';
import { WindowsProcessSupervisor } from '../src/main/services/WindowsProcessSupervisor';

const exec = promisify(execFile);

describe('project-default validation', () => {
  it('records deterministic command evidence and passes only existing scripts', async () => {
    const fixture = await setup();
    try {
      await writeFile(join(fixture.root, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"', lint: 'node -e "process.exit(0)"' } }));
      const status = await new ProjectValidationService(fixture.runs, new WindowsProcessSupervisor()).validate(fixture.run.id, fixture.root, validationOptions());
      expect(status).toBe('passed'); expect(fixture.runs.validationCommands(fixture.run.id).map((item) => [item.profileId, item.command, item.status, item.exitCode])).toEqual([['node-package-scripts-v1', 'npm run lint', 'passed', 0], ['node-package-scripts-v1', 'npm run test', 'passed', 0]]);
    } finally { await fixture.dispose(); }
  });

  it('uses only git diff --check for lightweight file-only changes', async () => {
    const fixture = await setup();
    try {
      await exec('git', ['init', fixture.root]); await exec('git', ['-C', fixture.root, 'config', 'user.email', 'test@nightshift.local']); await exec('git', ['-C', fixture.root, 'config', 'user.name', 'NightShift Test']);
      await writeFile(join(fixture.root, 'package.json'), JSON.stringify({ scripts: { typecheck: 'node -e "process.exit(0)"', lint: 'node -e "process.exit(0)"', test: 'node -e "process.exit(0)"', build: 'node -e "process.exit(0)"' } }));
      await exec('git', ['-C', fixture.root, 'add', 'package.json']); await exec('git', ['-C', fixture.root, 'commit', '-m', 'base']);
      await writeFile(join(fixture.root, 'SINGLE_AGENT_SMOKE.txt'), 'NightShift single-agent smoke test.\n');
      const status = await new ProjectValidationService(fixture.runs, new WindowsProcessSupervisor()).validate(fixture.run.id, fixture.root, validationOptions());
      expect(status).toBe('passed'); expect(fixture.runs.validationCommands(fixture.run.id).map((item) => [item.command, item.status, item.exitCode])).toEqual([['git diff --check', 'passed', 0]]);
    } finally { await fixture.dispose(); }
  });

  it('keeps failed validation independent from agent completion and bounds output', async () => {
    const fixture = await setup();
    try {
      await writeFile(join(fixture.root, 'package.json'), JSON.stringify({ scripts: { typecheck: 'node -e "process.stdout.write(\'x\'.repeat(70000)); process.exit(1)"' } }));
      fixture.runs.setStatus(fixture.run.id, 'completed');
      expect(await new ProjectValidationService(fixture.runs, new WindowsProcessSupervisor()).validate(fixture.run.id, fixture.root, validationOptions())).toBe('failed');
      const evidence = fixture.runs.validationCommands(fixture.run.id)[0]!;
      expect(fixture.runs.findRequired(fixture.run.id)).toMatchObject({ status: 'completed', validationStatus: 'failed' }); expect(evidence).toMatchObject({ command: 'npm run typecheck', status: 'failed', exitCode: 1, outputTruncated: true }); expect(Buffer.byteLength(evidence.output)).toBeLessThanOrEqual(64 * 1024);
    } finally { await fixture.dispose(); }
  });

  it('reports not configured when no supported project script exists', async () => {
    const fixture = await setup();
    try { await writeFile(join(fixture.root, 'package.json'), JSON.stringify({ scripts: { start: 'node app.js' } })); expect(await new ProjectValidationService(fixture.runs, new WindowsProcessSupervisor()).validate(fixture.run.id, fixture.root, validationOptions())).toBe('not_configured'); expect(fixture.runs.validationCommands(fixture.run.id)).toEqual([]); }
    finally { await fixture.dispose(); }
  });

  it('terminates a hanging owned validation command at its deadline and does not start later commands', async () => {
    vi.useFakeTimers();
    const fixture = await setup();
    try {
      await writeFile(join(fixture.root, 'package.json'), JSON.stringify({ scripts: { typecheck: 'node -e "process.exit(0)"', lint: 'node -e "process.exit(0)"' } }));
      const supervisor = new HangingSupervisor();
      const validation = new ProjectValidationService(fixture.runs, supervisor).validate(fixture.run.id, fixture.root, { deadline: Date.now() + 1, isCancellationRequested: () => false });
      await supervisor.waitUntilWaiting();
      await vi.advanceTimersByTimeAsync(1);
      expect(await validation).toBe('interrupted'); expect(supervisor.cancelledExecutionIds).toEqual(supervisor.startedExecutionIds); expect(fixture.runs.findRequired(fixture.run.id).validationStatus).toBe('interrupted'); expect(fixture.runs.validationCommands(fixture.run.id).map((command) => command.command)).toEqual(['npm run typecheck']); expect(fixture.runs.validationCommands(fixture.run.id)[0]!.status).toBe('interrupted');
    } finally { await fixture.dispose(); vi.useRealTimers(); }
  });

  it('terminates a hanging validation command when cancellation is requested', async () => {
    const fixture = await setup();
    try {
      let cancelled = false;
      await writeFile(join(fixture.root, 'package.json'), JSON.stringify({ scripts: { typecheck: 'node -e "process.exit(0)"', lint: 'node -e "process.exit(0)"' } }));
      const supervisor = new HangingSupervisor();
      const status = await new ProjectValidationService(fixture.runs, supervisor).validate(fixture.run.id, fixture.root, { deadline: Date.now() + 30_000, isCancellationRequested: () => cancelled, onProcessStarted: (cancel) => { cancelled = true; void cancel(); } });
      expect(status).toBe('interrupted'); expect(supervisor.cancelledExecutionIds).toEqual(supervisor.startedExecutionIds); expect(fixture.runs.findRequired(fixture.run.id).validationStatus).toBe('interrupted'); expect(fixture.runs.validationCommands(fixture.run.id).map((command) => command.command)).toEqual(['npm run typecheck']); expect(fixture.runs.validationCommands(fixture.run.id)[0]!.status).toBe('interrupted');
    } finally { await fixture.dispose(); }
  });
});

describe('restart recovery', () => {
  it('terminalizes stale runs, interrupts validation, preserves follow-up task state, and restores publishing retry', async () => {
    const fixture = await setup();
    try {
      fixture.tasks.setStatus(fixture.task.id, 'running'); fixture.runs.setStatus(fixture.run.id, 'running', { validation_status: 'running' }); fixture.runs.startValidationCommand(fixture.run.id, 'node-package-scripts-v1', 'npm run test');
      const source = fixture.runs.create({ taskId: fixture.task.id, workspaceId: fixture.workspace.id, resolvedAgentId: 'agent', resolvedModelId: 'model' }); fixture.runs.setCandidateCommit(source.id, 'nightshift/run/recovery', 'abc'); fixture.runs.setStatus(source.id, 'completed', { validation_status: 'running' }); fixture.runs.startValidationCommand(source.id, 'node-package-scripts-v1', 'npm run build'); expect(fixture.runs.tryBeginCandidatePublish(source.id)).toBe(true);
      const followUp = fixture.runs.create({ taskId: fixture.task.id, workspaceId: fixture.workspace.id, resolvedAgentId: 'agent', resolvedModelId: 'model', sourceRunId: source.id }); fixture.runs.setStatus(followUp.id, 'cancel_requested');
      fixture.service.recoverInterruptedRuns();
      expect(fixture.runs.findRequired(fixture.run.id)).toMatchObject({ status: 'blocked', validationStatus: 'interrupted' }); expect(fixture.runs.validationCommands(fixture.run.id)[0]!.status).toBe('interrupted'); expect(fixture.runs.findRequired(source.id)).toMatchObject({ status: 'completed', validationStatus: 'interrupted', candidatePublishState: 'failed' }); expect(fixture.runs.findRequired(followUp.id).status).toBe('blocked'); expect(fixture.tasks.findById(fixture.task.id)?.status).toBe('failed');
    } finally { await fixture.dispose(); }
  });
});

const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), 'nightshift-validation-')); const database = new DatabaseService(':memory:'); const workspaces = new WorkspaceRepository(database); const tasks = new PlannerTaskRepository(database); const runs = new RunRepository(database); const workspace = workspaces.addOrTouch(root, 'test', true); const task = tasks.create({ workspaceId: workspace.id, prompt: 'test', requestedAgentId: null, requestedModelId: null, priority: 1 }); const run = runs.create({ taskId: task.id, workspaceId: workspace.id, resolvedAgentId: 'agent', resolvedModelId: 'model' }); const service = new RunService(runs, tasks, workspaces, {} as never, new Map(), { agentId: 'agent', modelId: 'model', timeoutMs: 1 });
  return { root, runs, tasks, workspace, task, run, service, dispose: async () => { database.close(); await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 75 }); } };
};
const validationOptions = () => ({ deadline: Date.now() + 30_000, isCancellationRequested: () => false });

class HangingSupervisor implements ProcessSupervisor {
  public readonly startedExecutionIds: string[] = [];
  public readonly cancelledExecutionIds: string[] = [];
  private readonly completionPromises = new Map<string, Promise<SupervisedProcessResult>>();
  private readonly completionResolvers = new Map<string, (result: SupervisedProcessResult) => void>();
  private readonly specs = new Map<string, SupervisedProcessSpec>();
  private resolveWaiting: (() => void) | null = null;
  private readonly waiting = new Promise<void>((resolve) => { this.resolveWaiting = resolve; });

  public start(spec: SupervisedProcessSpec): Promise<SupervisedProcessSnapshot> {
    this.startedExecutionIds.push(spec.executionId);
    this.specs.set(spec.executionId, spec);
    this.completionPromises.set(spec.executionId, new Promise((resolve) => this.completionResolvers.set(spec.executionId, resolve)));
    return Promise.resolve(runningSnapshot(spec.executionId));
  }

  public snapshot(executionId: string): SupervisedProcessSnapshot | undefined {
    return this.specs.has(executionId) ? runningSnapshot(executionId) : undefined;
  }

  public subscribe(): () => void { return () => undefined; }

  public waitForCompletion(executionId: string): Promise<SupervisedProcessResult> {
    this.resolveWaiting?.();
    return this.completionPromises.get(executionId)!;
  }

  public cancelOwnedTree(executionId: string): Promise<void> {
    this.cancelledExecutionIds.push(executionId);
    this.completionResolvers.get(executionId)?.({ ...runningSnapshot(executionId), state: 'exited', cancellationRequested: true, finishedAt: '2026-08-27T00:00:00.000Z', exitCode: null, signal: 'SIGTERM', stdout: '', stderr: '' });
    return Promise.resolve();
  }

  public waitUntilWaiting(): Promise<void> { return this.waiting; }
}

const runningSnapshot = (executionId: string): SupervisedProcessSnapshot => ({ executionId, processId: 1, state: 'running', startedAt: '2026-08-27T00:00:00.000Z', lastOutputAt: null, finishedAt: null, cancellationRequested: false, exitCode: null, failureReason: null });
