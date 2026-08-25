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
import { DelegatedRunOrchestrator } from '../src/main/services/DelegatedRunOrchestrator';
import { DelegatedLeaderClient, type LeaderClient, type LeaderDecision, type LeaderRequest } from '../src/main/services/DelegatedLeaderClient';
import type { FccGateway, FccHealth, FccMessageRequest } from '../src/main/services/contracts/FccGateway';
import { GitWorktreeService } from '../src/main/services/GitWorktreeService';
import { ProjectValidationService } from '../src/main/services/ProjectValidationService';
import { RunReviewService } from '../src/main/services/RunReviewService';
import { RunService } from '../src/main/services/RunService';
import { WindowsProcessSupervisor } from '../src/main/services/WindowsProcessSupervisor';
import type { AgentAdapter, AgentExecutionHandle, AgentExecutionResult, RunStartSpec } from '../src/main/services/contracts/AgentAdapter';
import type { AgentCapabilities, AgentDescriptor, ModelDescriptor } from '../src/shared/domain/entities';

const exec = promisify(execFile);
const caps: AgentCapabilities = { interactive: false, headless: true, structuredEvents: true, rawPty: false, resume: false, modelOverride: true, cancel: true, workingDirectory: true, imageInput: false, subagents: false, plannerValidated: true, workerValidated: true, renderMode: 'structured' };
const luna: ModelDescriptor = { id: 'fcc/openai/luna', providerId: 'openai', displayName: 'Luna', rawModelRef: 'openai/luna', lastSeenAt: new Date().toISOString() };

describe('Delegated Leader autonomous correction', () => {
  it('keeps one Run and one worktree while Luna corrects a failed attempt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nightshift-delegated-')); const repo = join(root, 'repo');
    try {
      await exec('git', ['init', repo]); await exec('git', ['-C', repo, 'config', 'user.email', 'test@nightshift']); await exec('git', ['-C', repo, 'config', 'user.name', 'test']);
      await writeFile(join(repo, 'package.json'), JSON.stringify({ scripts: { typecheck: "node -e \"process.exit(require('fs').readFileSync('implementation.txt','utf8').includes('fixed')?0:1)\"" } })); await writeFile(join(repo, 'implementation.txt'), 'base'); await exec('git', ['-C', repo, 'add', '.']); await exec('git', ['-C', repo, 'commit', '-m', 'base']); await exec('git', ['-C', repo, 'branch', '-M', 'dev']);
      const db = new DatabaseService(':memory:'); const workspaces = new WorkspaceRepository(db); const tasks = new PlannerTaskRepository(db); const runs = new RunRepository(db); const workspace = workspaces.addOrTouch(repo, 'repo', true); const worker = new CorrectionWorker(); const leader = new QueuedLeader([{ protocolVersion: 1, action: 'WORK', instruction: 'implement', summary: 'start' }, { protocolVersion: 1, action: 'WORK', instruction: 'fix validation', summary: 'fix' }, { protocolVersion: 1, action: 'DONE', summary: 'validated' }]);
      const supervisor = new WindowsProcessSupervisor(); const delegated = new DelegatedRunOrchestrator(runs, new ProjectValidationService(runs, supervisor), new RunReviewService(runs, workspaces), leader); const service = new RunService(runs, tasks, workspaces, new GitWorktreeService(join(root, 'worktrees')), new Map([[worker.id, worker]]), { agentId: worker.id, modelId: 'model', timeoutMs: 10_000 }, supervisor, undefined, delegated);
      tasks.create({ workspaceId: workspace.id, prompt: 'Fix implementation', requestedAgentId: worker.id, requestedModelId: 'model', priority: 1, executionMode: 'delegated_leader' }); service.schedule();
      const run = await waitFor(() => service.list(workspace.id)[0]); const completed = await waitFor(async () => { const current = await service.find(run.id); return current && ['completed', 'blocked', 'cancelled', 'timed_out'].includes(current.status) ? current : undefined; }, 10_000); if (completed.status !== 'completed') throw new Error(`${completed.status}: ${completed.failureReason} ${JSON.stringify(service.events(run.id).events)}`);
      expect(tasks.listVisible(workspace.id)).toHaveLength(1); expect(runs.attempts(completed.id)).toHaveLength(2); expect(worker.directories).toEqual([completed.worktreePath, completed.worktreePath]); expect(worker.secondSawBroken).toBe(true); expect(runs.attempts(completed.id).map((attempt) => attempt.validationStatus)).toEqual(['failed', 'passed']); expect(leader.requests[1]!.evidence.validationStatus).toBe('failed'); expect(leader.requests.at(-1)!.budget.remainingAttempts).toBe(2); expect(completed.validationStatus).toBe('passed'); expect(completed.candidatePublishState).toBe('not_published'); expect(service.events(completed.id).events.map((event) => event.eventType)).not.toContain('follow_up_created');
      db.close();
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 3 }); }
  }, 15_000);

  it('rejects DONE after failed validation and requests a corrective decision', async () => {
    const fixture = await delegatedFixture(new CorrectionWorker(), new QueuedLeader([{ protocolVersion: 1, action: 'WORK', instruction: 'break', summary: 'start' }, { protocolVersion: 1, action: 'DONE', summary: 'incorrectly done' }, { protocolVersion: 1, action: 'BLOCKED', summary: 'cannot fix', blocker: 'needs input' }]));
    try { const run = await fixture.start(); const terminal = await fixture.terminal(run.id); expect(terminal.status).toBe('blocked'); expect(fixture.leader.requests).toHaveLength(3); expect(fixture.leader.requests[2]!.evidence.priorAttemptSummaries).toContain('DONE is forbidden because validation did not pass. Return WORK or BLOCKED.'); }
    finally { await fixture.dispose(); }
  }, 15_000);

  it('launches another fresh attempt when green validation receives WORK', async () => {
    const fixture = await delegatedFixture(new FixedWorker(), new QueuedLeader([{ protocolVersion: 1, action: 'WORK', instruction: 'implement', summary: 'start' }, { protocolVersion: 1, action: 'WORK', instruction: 'inspect again', summary: 'continue' }, { protocolVersion: 1, action: 'DONE', summary: 'done' }]));
    try { const run = await fixture.start(); const terminal = await fixture.terminal(run.id); expect(terminal.status).toBe('completed'); expect(fixture.runs.attempts(run.id)).toHaveLength(2); expect(fixture.worker.directories).toEqual([terminal.worktreePath, terminal.worktreePath]); }
    finally { await fixture.dispose(); }
  }, 15_000);

  it('blocks after the bounded attempt budget without launching an extra Worker', async () => {
    const fixture = await delegatedFixture(new FixedWorker(), new QueuedLeader(Array.from({ length: 5 }, (_, index) => ({ protocolVersion: 1 as const, action: 'WORK' as const, instruction: `attempt ${index}`, summary: 'continue' }))));
    try { const run = await fixture.start(); const terminal = await fixture.terminal(run.id); expect(terminal.status).toBe('blocked'); expect(terminal.failureReason).toContain('attempt_budget_exhausted'); expect(fixture.runs.attempts(run.id)).toHaveLength(4); expect(fixture.worker.directories).toHaveLength(4); expect(terminal.worktreePath).toBeTruthy(); }
    finally { await fixture.dispose(); }
  }, 15_000);

  it('repairs one malformed Leader response, then blocks and persists protocol evidence after the second invalid response', async () => {
    const gateway = new ScriptedFccGateway(['not json', '{"protocolVersion":1,"action":"WORK","summary":"missing instruction"}']);
    const fixture = await delegatedFixture(new FixedWorker(), new DelegatedLeaderClient(gateway));
    try {
      const run = await fixture.start(); const terminal = await fixture.terminal(run.id);
      expect(terminal.status).toBe('blocked'); expect(gateway.messages).toHaveLength(2); expect(fixture.worker.directories).toHaveLength(0);
      expect(fixture.runs.listEvents(run.id).filter((event) => event.eventType === 'leader_protocol_error')).toHaveLength(1);
      expect(terminal.failureReason).toContain('Leader response does not match the decision schema.');
    } finally { await fixture.dispose(); }
  }, 15_000);

  it('blocks during Luna preflight without launching a Worker when FCC resolution is unavailable', async () => {
    const fixture = await delegatedFixture(new FixedWorker(), new UnavailableLeader('FCC Luna catalog is unavailable.'));
    try {
      const run = await fixture.start(); const terminal = await fixture.terminal(run.id);
      expect(terminal.status).toBe('blocked'); expect(terminal.failureReason).toContain('FCC Luna catalog is unavailable.'); expect(fixture.worker.directories).toHaveLength(0);
      expect(fixture.runs.listEvents(run.id).some((event) => event.eventType === 'leader_request')).toBe(false);
    } finally { await fixture.dispose(); }
  }, 15_000);

  it('recovers from a failed Worker attempt in the same worktree', async () => {
    const worker = new FailingThenFixedWorker(); const leader = new QueuedLeader([{ protocolVersion: 1, action: 'WORK', instruction: 'implement', summary: 'start' }, { protocolVersion: 1, action: 'WORK', instruction: 'recover', summary: 'retry' }, { protocolVersion: 1, action: 'DONE', summary: 'done' }]); const fixture = await delegatedFixture(worker, leader);
    try { const run = await fixture.start(); const terminal = await fixture.terminal(run.id); expect(terminal.status).toBe('completed'); expect(worker.directories).toEqual([terminal.worktreePath, terminal.worktreePath]); expect(leader.requests[1]!.attempt?.workerFailureReason).toContain('Worker failed'); }
    finally { await fixture.dispose(); }
  }, 15_000);

  it('cancels an active Leader request without starting a Worker', async () => {
    const leader = new HangingLeader(); const fixture = await delegatedFixture(new FixedWorker(), leader);
    try { const run = await fixture.start(); await waitFor(() => leader.started); await fixture.service.requestCancellation(run.id); const terminal = await fixture.terminal(run.id); expect(terminal.status).toBe('cancelled'); expect(leader.aborted).toBe(true); expect(fixture.worker.directories).toHaveLength(0); }
    finally { await fixture.dispose(); }
  }, 15_000);

  it('cancels an active Worker and preserves its isolated worktree', async () => {
    const worker = new HangingWorker(); const fixture = await delegatedFixture(worker, new QueuedLeader([{ protocolVersion: 1, action: 'WORK', instruction: 'work', summary: 'start' }]));
    try { const run = await fixture.start(); await waitFor(() => worker.directories.length === 1); await fixture.service.requestCancellation(run.id); const terminal = await fixture.terminal(run.id); expect(terminal.status).toBe('cancelled'); expect(worker.cancelled).toBe(1); expect(worker.directories).toHaveLength(1); expect(terminal.worktreePath).toBeTruthy(); }
    finally { await fixture.dispose(); }
  }, 15_000);

  it('cancels active deterministic validation without launching another Worker', async () => {
    const fixture = await delegatedFixture(new FixedWorker(), new QueuedLeader([{ protocolVersion: 1, action: 'WORK', instruction: 'work', summary: 'start' }]), { validationScript: "node -e \"setTimeout(()=>process.exit(0),5000)\"" });
    try { const run = await fixture.start(); await waitFor(() => fixture.runs.validationCommands(run.id).some((command) => command.status === 'running')); await fixture.service.requestCancellation(run.id); const terminal = await fixture.terminal(run.id); expect(terminal.status).toBe('cancelled'); expect(fixture.worker.directories).toHaveLength(1); expect(fixture.runs.validationCommands(run.id).some((command) => command.status === 'interrupted')).toBe(true); expect(terminal.worktreePath).toBeTruthy(); }
    finally { await fixture.dispose(); }
  }, 15_000);

  it('uses one deadline for the entire autonomous Run and cancels the active Worker on timeout', async () => {
    const worker = new HangingWorker(); const fixture = await delegatedFixture(worker, new QueuedLeader([{ protocolVersion: 1, action: 'WORK', instruction: 'work', summary: 'start' }]), { timeoutMs: 1_500 });
    try { const run = await fixture.start(); const terminal = await fixture.terminal(run.id); expect(terminal.status).toBe('timed_out'); expect(worker.cancelled).toBe(1); expect(worker.directories).toHaveLength(1); }
    finally { await fixture.dispose(); }
  }, 15_000);

  it('blocks a persisted active delegated Run on restart without discarding worktree evidence', async () => {
    const worker = new HangingWorker(); const fixture = await delegatedFixture(worker, new QueuedLeader([{ protocolVersion: 1, action: 'WORK', instruction: 'work', summary: 'start' }]));
    try { const run = await fixture.start(); await waitFor(() => worker.directories.length === 1); const before = await fixture.service.find(run.id); fixture.runs.appendEvent(run.id, 'leader_request', { preserved: true }); fixture.service.recoverInterruptedRuns(); const recovered = await fixture.service.find(run.id); expect(recovered?.status).toBe('blocked'); expect(recovered?.worktreePath).toBe(before?.worktreePath); expect(fixture.runs.listEvents(run.id).some((event) => event.eventType === 'leader_request')).toBe(true); expect(worker.directories).toHaveLength(1); }
    finally { await fixture.dispose(); }
  }, 15_000);
});

class QueuedLeader implements LeaderClient { public readonly requests: LeaderRequest[] = []; public constructor(private readonly decisions: LeaderDecision[]) {} public resolveLuna(): Promise<ModelDescriptor> { return Promise.resolve(luna); } public decide(_model: string, request: LeaderRequest): Promise<LeaderDecision> { this.requests.push(request); const next = this.decisions.shift(); if (!next) throw new Error('Unexpected Leader request.'); return Promise.resolve(next); } }
class CorrectionWorker implements AgentAdapter {
  public readonly id = 'fake'; public readonly directories: string[] = []; public secondSawBroken = false; public capabilities = (): AgentCapabilities => caps; public supportsPlannerModel = (): boolean => true; public supportsWorkerModel = (): boolean => true; public detect = (): Promise<AgentDescriptor> => Promise.resolve({ id: this.id, displayName: 'fake', fccLauncher: 'fake', installed: true, launchable: true, version: null, capabilities: caps, lastValidatedAt: null });
  public async startRun(spec: RunStartSpec): Promise<AgentExecutionHandle> { this.directories.push(spec.workingDirectory); if (this.directories.length === 2) this.secondSawBroken = (await readFile(join(spec.workingDirectory, 'implementation.txt'), 'utf8')) === 'broken'; await writeFile(join(spec.workingDirectory, 'implementation.txt'), this.directories.length === 1 ? 'broken' : 'fixed'); const result: AgentExecutionResult = { handleId: spec.runId, succeeded: true, failureReason: null, exitCode: 0, signal: null, externalSessionId: null, events: [], terminalEvent: null, stderr: '' }; return { handleId: spec.runId, externalSessionId: null, events: [], completion: Promise.resolve(result) }; }
  public startWorker(): Promise<AgentExecutionHandle> { return Promise.reject(new Error('Delegated attempts must use startRun.')); } public cancel(): Promise<void> { return Promise.resolve(); }
}
class FixedWorker extends CorrectionWorker { public override async startRun(spec: RunStartSpec): Promise<AgentExecutionHandle> { this.directories.push(spec.workingDirectory); await writeFile(join(spec.workingDirectory, 'implementation.txt'), 'fixed'); const result: AgentExecutionResult = { handleId: spec.runId, succeeded: true, failureReason: null, exitCode: 0, signal: null, externalSessionId: null, events: [], terminalEvent: null, stderr: '' }; return { handleId: spec.runId, externalSessionId: null, events: [], completion: Promise.resolve(result) }; } }
class FailingThenFixedWorker extends FixedWorker { public override async startRun(spec: RunStartSpec): Promise<AgentExecutionHandle> { if (this.directories.length) return super.startRun(spec); this.directories.push(spec.workingDirectory); return { handleId: spec.runId, externalSessionId: null, events: [], completion: Promise.resolve({ handleId: spec.runId, succeeded: false, failureReason: 'Worker failed deliberately.', exitCode: 1, signal: null, externalSessionId: null, events: [], terminalEvent: null, stderr: '' }) }; } }
class HangingWorker extends FixedWorker { public cancelled = 0; private resolve?: (result: AgentExecutionResult) => void; public override startRun(spec: RunStartSpec): Promise<AgentExecutionHandle> { this.directories.push(spec.workingDirectory); const completion = new Promise<AgentExecutionResult>((resolve) => { this.resolve = resolve; }); return Promise.resolve({ handleId: spec.runId, externalSessionId: null, events: [], completion }); } public override cancel(): Promise<void> { this.cancelled += 1; this.resolve?.({ handleId: 'cancelled', succeeded: false, failureReason: 'Cancelled.', exitCode: null, signal: 'SIGTERM', externalSessionId: null, events: [], terminalEvent: null, stderr: '' }); return Promise.resolve(); } }
class HangingLeader implements LeaderClient { public started = false; public aborted = false; public resolveLuna(): Promise<ModelDescriptor> { return Promise.resolve(luna); } public decide(_model: string, _request: LeaderRequest, signal: AbortSignal): Promise<LeaderDecision> { this.started = true; return new Promise((_resolve, reject) => signal.addEventListener('abort', () => { this.aborted = true; reject(new Error('aborted')); }, { once: true })); } }
class ScriptedFccGateway implements FccGateway {
  public readonly messages: FccMessageRequest[] = [];
  public constructor(private readonly replies: string[]) {}
  public detect(): Promise<FccHealth> { return Promise.resolve(unavailableHealth); }
  public ensureAvailable(): Promise<FccHealth> { return Promise.resolve(unavailableHealth); }
  public health(): Promise<FccHealth> { return Promise.resolve(unavailableHealth); }
  public listModels(): Promise<readonly ModelDescriptor[]> { return Promise.resolve([luna]); }
  public stopOwnedProcess(): Promise<void> { return Promise.resolve(); }
  public createMessage(request: FccMessageRequest): Promise<unknown> { this.messages.push(request); return Promise.resolve({ content: this.replies.shift() ?? '' }); }
}
class UnavailableLeader implements LeaderClient {
  public constructor(private readonly reason: string) {}
  public resolveLuna(): Promise<ModelDescriptor> { return Promise.reject(new Error(this.reason)); }
  public decide(): Promise<LeaderDecision> { return Promise.reject(new Error('Leader preflight must complete before deciding.')); }
}
const unavailableHealth: FccHealth = { state: 'unavailable', available: false, endpoint: null, version: null, ownedByNightShift: false, detail: 'test', failureReason: null };
const delegatedFixture = async <TLeader extends LeaderClient>(worker: CorrectionWorker, leader: TLeader, options: { timeoutMs?: number; validationScript?: string } = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'nightshift-delegated-cases-')); const repo = join(root, 'repo'); await exec('git', ['init', repo]); await exec('git', ['-C', repo, 'config', 'user.email', 'test@nightshift']); await exec('git', ['-C', repo, 'config', 'user.name', 'test']); await writeFile(join(repo, 'package.json'), JSON.stringify({ scripts: { typecheck: options.validationScript ?? "node -e \"process.exit(require('fs').readFileSync('implementation.txt','utf8').includes('fixed')?0:1)\"" } })); await writeFile(join(repo, 'implementation.txt'), 'base'); await exec('git', ['-C', repo, 'add', '.']); await exec('git', ['-C', repo, 'commit', '-m', 'base']); await exec('git', ['-C', repo, 'branch', '-M', 'dev']);
  const db = new DatabaseService(':memory:'); const workspaces = new WorkspaceRepository(db); const tasks = new PlannerTaskRepository(db); const runs = new RunRepository(db); const workspace = workspaces.addOrTouch(repo, 'repo', true); const supervisor = new WindowsProcessSupervisor(); const delegated = new DelegatedRunOrchestrator(runs, new ProjectValidationService(runs, supervisor), new RunReviewService(runs, workspaces), leader); const service = new RunService(runs, tasks, workspaces, new GitWorktreeService(join(root, 'worktrees')), new Map([[worker.id, worker]]), { agentId: worker.id, modelId: 'model', timeoutMs: options.timeoutMs ?? 10_000 }, supervisor, undefined, delegated);
  return { runs, worker, leader, service, start: async () => { tasks.create({ workspaceId: workspace.id, prompt: 'Fixture task', requestedAgentId: worker.id, requestedModelId: 'model', priority: 1, executionMode: 'delegated_leader' }); service.schedule(); return waitFor(() => service.list(workspace.id)[0]); }, terminal: async (id: string) => waitFor(async () => { const run = await service.find(id); return run && ['completed', 'blocked', 'cancelled', 'timed_out'].includes(run.status) ? run : undefined; }, 10_000), dispose: async () => { db.close(); await rm(root, { recursive: true, force: true, maxRetries: 3 }); } };
};
const waitFor = async <T>(read: () => T | Promise<T>, timeout = 2_000): Promise<NonNullable<T>> => { const until = Date.now() + timeout; for (;;) { const value = await read(); if (value) return value; if (Date.now() >= until) throw new Error('Timed out waiting for delegated Run.'); await new Promise((resolve) => setTimeout(resolve, 10)); } };
