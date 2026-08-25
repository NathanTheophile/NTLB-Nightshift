import type { AgentAdapter, AgentExecutionResult } from './contracts/AgentAdapter';
import type { RunService as RunServiceContract } from './contracts/RunService';
import { runGit, type GitCommandResult } from './GitWorktreeService';
import { assertNodeValidationDependencies, ProjectValidationService } from './ProjectValidationService';
import { WindowsProcessSupervisor } from './WindowsProcessSupervisor';
import type { ProcessSupervisor } from './contracts/ProcessSupervisor';
import type { WorktreeService } from './contracts/WorktreeService';
import type { PlannerTaskRepository } from '../persistence/repositories/PlannerTaskRepository';
import type { RunRepository } from '../persistence/repositories/RunRepository';
import type { WorkspaceRepository } from '../persistence/repositories/WorkspaceRepository';
import type { SettingsRepository } from '../persistence/repositories/SettingsRepository';
import type { BatchStep, Run, RunEventKind, RunStatus } from '@shared/domain/entities';
import type { RunNavigationItem } from '@shared/contracts/ipc';
import { resolve } from 'node:path';
import { resolveEffectiveDevBase } from './ReviewIntegrationService';
import type { DelegatedRunOrchestrator } from './DelegatedRunOrchestrator';

const terminalStatuses = new Set<RunStatus>(['completed', 'failed', 'blocked', 'cancelled', 'timed_out']);

export interface PlannerRunDefaults { agentId: string; modelId: string; timeoutMs: number; }
export class RunService implements RunServiceContract {
  private readonly active = new Map<string, { cancel: () => Promise<void>; timedOut: boolean }>();
  private readonly publishing = new Map<string, Promise<Run>>();
  private readonly followUpQueue: string[] = [];
  private readonly validation: ProjectValidationService;
  private readonly slots = new Map<string, Promise<void>>();
  private configuredConcurrency: number | undefined;
  private scheduling = false;
  private scheduleRequested = false;
  public constructor(private readonly runs: RunRepository, private readonly tasks: PlannerTaskRepository, private readonly workspaces: WorkspaceRepository, private readonly worktrees: WorktreeService, private readonly adapters: ReadonlyMap<string, AgentAdapter>, private readonly defaults: PlannerRunDefaults, validationSupervisor: ProcessSupervisor = new WindowsProcessSupervisor(), private readonly settings?: SettingsRepository, private readonly delegated?: DelegatedRunOrchestrator) { this.validation = new ProjectValidationService(runs, validationSupervisor); }
  public createAttempt(spec: { taskId: string; workspaceId: string; resolvedAgentId: string; resolvedModelId: string; baseSha: string }): Promise<Run> {
    const run = this.runs.create(spec);
    return Promise.resolve(this.runs.setBaseSha(run.id, spec.baseSha));
  }
  public find(runId: string): Promise<Run | undefined> { return Promise.resolve(this.runs.find(runId)); }
  public list(workspaceId: string): Run[] { return this.runs.list(workspaceId); }
  public navigation(workspaceId: string): RunNavigationItem[] {
    return this.runs.list(workspaceId).map((run) => ({
      id: run.id, taskId: run.taskId, taskTitle: this.tasks.findById(run.taskId)?.title ?? 'Tâche indisponible',
      status: run.status, createdAt: run.createdAt, resolvedAgentId: run.resolvedAgentId, resolvedModelId: run.resolvedModelId,
    }));
  }
  public events(runId: string, kind: RunEventKind = 'activity', cursor: number | null = null, limit = 100) { return this.runs.listEventPage(runId, kind, cursor, limit); }
  public batchSteps(runId: string) { return this.runs.batchSteps(runId); }
  public validationCommands(runId: string) { return this.runs.validationCommands(runId); }
  public recoverInterruptedRuns(): void {
    const reason = 'Interrupted by NightShift restart; process was not resumed. Worktree and evidence were preserved.';
    for (const run of this.runs.runningValidations()) { this.runs.interruptRunningValidation(run.id); this.runs.setValidationStatus(run.id, 'interrupted'); this.runs.appendEvent(run.id, 'validation_recovered_after_restart', { reason: 'Validation was not resumed.' }); }
    for (const run of this.runs.staleRuns()) {
      for (const step of this.runs.batchSteps(run.id)) if (step.status === 'running') this.runs.setBatchStepStatus(step.id, 'failed', { finished_at: new Date().toISOString(), failure_reason: reason }); else if (step.status === 'pending') this.runs.setBatchStepStatus(step.id, 'cancelled', { finished_at: new Date().toISOString(), failure_reason: reason });
      this.runs.setStatus(run.id, 'blocked', { finished_at: new Date().toISOString(), failure_reason: reason }); this.runs.appendEvent(run.id, 'recovered_after_restart', { previousStatus: run.status, reason });
      if (!run.sourceRunId) this.tasks.setStatus(run.taskId, 'failed');
    }
    for (const run of this.runs.publishingCandidates()) { const reason = 'Candidate publishing interrupted by NightShift restart; retry is available.'; this.runs.setCandidatePublishFailure(run.id, reason); this.runs.appendEvent(run.id, 'candidate_publish_recovered', { reason }); }
  }
  public concurrencyLimit(): number { return this.configuredConcurrency ?? normalizeConcurrency(this.settings?.get<number>('planner.concurrent_runs')); }
  public setConcurrencyLimit(limit: number): number {
    const normalized = normalizeConcurrency(limit);
    if (limit !== normalized) throw new Error('Concurrent Planner Runs must be 1, 2, 3, or 4.');
    this.configuredConcurrency = normalized;
    this.settings?.set('planner.concurrent_runs', normalized);
    this.schedule();
    return normalized;
  }
  public schedule(): void {
    this.scheduleRequested = true;
    if (!this.scheduling) void this.fillSlots().catch((error: unknown) => console.error('[Planner] Scheduler stopped unexpectedly.', error));
  }
  public async requestCancellation(runId: string): Promise<Run> {
    const run = this.runs.findRequired(runId); if (terminalStatuses.has(run.status)) return run;
    this.runs.setStatus(runId, 'cancel_requested'); this.runs.appendEvent(runId, 'cancellation_requested', {});
    const active = this.active.get(runId); if (active) await active.cancel();
    return this.runs.findRequired(runId);
  }
  public publishCandidate(runId: string): Promise<Run> {
    const existing = this.publishing.get(runId); if (existing) return existing;
    const operation = this.publishCandidateInternal(runId).finally(() => this.publishing.delete(runId));
    this.publishing.set(runId, operation);
    return operation;
  }
  public createFollowUp(runId: string, prompt: string): Promise<Run> {
    const correctivePrompt = prompt.trim();
    if (!correctivePrompt) return Promise.reject(new Error('A corrective prompt is required.'));
    const source = this.runs.findRequired(runId);
    if (source.status !== 'completed' || source.candidatePublishState !== 'published' || !source.candidateCommitSha) {
      return Promise.reject(new Error('Follow-up Runs require a completed Run with a published candidate.'));
    }
    const run = this.runs.create({ taskId: source.taskId, workspaceId: source.workspaceId, resolvedAgentId: source.resolvedAgentId, resolvedModelId: source.resolvedModelId, executionMode: 'single_agent', sourceRunId: source.id, followUpPrompt: correctivePrompt });
    this.runs.appendEvent(run.id, 'follow_up_created', { sourceRunId: source.id, baseSha: source.candidateCommitSha });
    this.followUpQueue.push(run.id); this.schedule();
    return Promise.resolve(run);
  }
  // Scheduling work is intentionally synchronous until the launched Run promises yield.
  // eslint-disable-next-line @typescript-eslint/require-await
  private async fillSlots(): Promise<void> {
    this.scheduling = true;
    try {
      do {
        this.scheduleRequested = false;
        while (this.slots.size < this.concurrencyLimit()) {
          const followUpRunId = this.followUpQueue.shift();
          if (followUpRunId) {
            const run = this.runs.find(followUpRunId);
            if (!run || terminalStatuses.has(run.status) || this.slots.has(run.id)) continue;
            this.launch(run.taskId, run.id);
            continue;
          }
          const task = this.tasks.claimNextQueued();
          if (!task) break;
          this.launch(task.id);
        }
      } while (this.scheduleRequested && this.slots.size < this.concurrencyLimit());
    } finally {
      this.scheduling = false;
      if (this.scheduleRequested && this.slots.size < this.concurrencyLimit()) this.schedule();
    }
  }
  private launch(taskId: string, existingRunId?: string): void {
    const task = this.tasks.findById(taskId);
    if (!task) return;
    const runId = existingRunId ?? this.runs.create({
      taskId: task.id,
      workspaceId: task.workspaceId,
      resolvedAgentId: task.requestedAgentId ?? this.defaults.agentId,
      resolvedModelId: task.requestedModelId ?? this.defaults.modelId,
      executionMode: task.executionMode,
    }).id;
    const reservation = this.execute(taskId, runId).catch((error: unknown) => console.error('[Planner] Run failed unexpectedly.', error)).finally(() => {
      this.slots.delete(runId);
      this.schedule();
    });
    this.slots.set(runId, reservation);
  }
  private async execute(taskId: string, existingRunId?: string): Promise<void> {
    const task = this.tasks.findById(taskId); if (!task || (!existingRunId && task.status !== 'running')) return;
    const workspace = this.workspaces.findById(task.workspaceId); const requestedAgentId = task.requestedAgentId ?? this.defaults.agentId; const requestedModelId = task.requestedModelId ?? this.defaults.modelId;
    const run = existingRunId ? this.runs.findRequired(existingRunId) : this.runs.create({ taskId: task.id, workspaceId: task.workspaceId, resolvedAgentId: requestedAgentId, resolvedModelId: requestedModelId, executionMode: task.executionMode });
    const agentId = run.resolvedAgentId; const modelId = run.resolvedModelId; const isFollowUp = Boolean(run.sourceRunId);
    const batchSteps = run.executionMode === 'sequential_batch' ? this.runs.createBatchSteps(run.id, this.tasks.batchSteps(task.id)) : [];
    this.runs.appendEvent(run.id, 'preparing', { agentId, modelId, executionMode: run.executionMode });
    try {
      if (!workspace?.isGit) throw new Error('Write-capable Planner runs require a Git workspace.');
      const adapter = this.adapters.get(agentId); if (!adapter || (run.executionMode === 'delegated_leader' ? !adapter.capabilities().workerValidated : !adapter.capabilities().plannerValidated)) throw new Error(`Planner agent ${agentId} is not validated.`);
      if (run.executionMode !== 'delegated_leader' && adapter.supportsPlannerModel && !adapter.supportsPlannerModel(modelId)) throw new Error(`Planner model ${modelId} is not validated for ${agentId}.`);
      const head = run.sourceRunId ? this.followUpBase(run.sourceRunId) : await this.plannerBase(workspace.rootPath, workspace.id);
      if (head.exitCode !== 0) throw new Error('Could not determine Git base for Planner run.');
      if (await this.finalizeIfCancellationRequested(run.id, task.id, batchSteps)) return;
      await assertNodeValidationDependencies(workspace.rootPath);
      const worktree = await this.worktrees.createForRun({ runId: run.id, repositoryRoot: workspace.rootPath, baseSha: head.stdout.trim() });
      this.runs.setPreparation(run.id, worktree.baseSha, worktree.path); this.runs.appendEvent(run.id, 'worktree_created', worktree);
      if (await this.finalizeIfCancellationRequested(run.id, task.id, batchSteps)) return;
      this.runs.setStatus(run.id, 'running', { started_at: new Date().toISOString() }); this.runs.appendEvent(run.id, 'running', {});
      const deadline = Date.now() + this.defaults.timeoutMs;
      if (run.executionMode === 'delegated_leader') {
        if (!this.delegated) throw new Error('Delegated Leader runtime is not configured.');
        const status = await this.delegated.execute({ run, task, worktreePath: worktree.path, adapter, deadline, isCancellationRequested: () => this.runs.findRequired(run.id).status === 'cancel_requested', setActive: (cancel) => this.active.set(run.id, { cancel, timedOut: false }), clearActive: () => this.active.delete(run.id) });
        const finalGit = await inspectGit(worktree.path);
        const autonomous = this.runs.findRequired(run.id); this.runs.setAutonomyPhase(run.id, 'terminal'); this.runs.setStatus(run.id, status, { finished_at: new Date().toISOString(), failure_reason: status === 'blocked' ? autonomous.failureReason ?? 'Delegated Leader blocked autonomous continuation.' : status === 'timed_out' ? 'Run exceeded the hard timeout.' : status === 'cancelled' ? 'Cancelled by user.' : null, validation_status: autonomous.validationStatus ?? 'not_configured', final_head_sha: finalGit.head, final_git_state: JSON.stringify(finalGit) });
        this.tasks.setStatus(task.id, taskStatus(status)); this.runs.appendEvent(run.id, 'terminal', { status });
        if (status === 'completed') await this.publishDelegatedCandidate(run.id);
        return;
      }
      const result = run.executionMode === 'sequential_batch'
        ? await this.executeBatch(run.id, workspace.id, worktree.path, modelId, adapter, followUpPrompt(task.prompt, run.followUpPrompt), batchSteps, deadline)
        : await this.executeSingle(run.id, workspace.id, worktree.path, modelId, adapter, followUpPrompt(task.prompt, run.followUpPrompt), deadline);
      const current = this.runs.findRequired(run.id); const cancelled = current.status === 'cancel_requested';
      let status: RunStatus = current.status === 'timed_out' ? 'timed_out' : cancelled ? 'cancelled' : result.succeeded ? 'completed' : 'failed';
      if (status === 'completed') {
        const validationStatus = await this.validation.validate(run.id, worktree.path, { deadline, isCancellationRequested: () => this.runs.findRequired(run.id).status === 'cancel_requested', onProcessStarted: (cancel) => this.active.set(run.id, { cancel, timedOut: false }), onProcessFinished: () => this.active.delete(run.id) });
        const afterValidation = this.runs.findRequired(run.id);
        if (afterValidation.status === 'cancel_requested') status = 'cancelled';
        else if (validationStatus === 'interrupted' && Date.now() >= deadline) { status = 'timed_out'; this.runs.appendEvent(run.id, 'timeout', { phase: 'validation' }); }
      }
      const finalGit = await inspectGit(worktree.path);
      if (!isFollowUp) this.tasks.setStatus(task.id, taskStatus(status));
      this.runs.setStatus(run.id, status, { finished_at: new Date().toISOString(), exit_code: result.exitCode, result_summary: result.terminalEvent?.raw ?? null, failure_reason: status === 'completed' ? null : status === 'timed_out' ? 'Run exceeded the hard timeout.' : result.failureReason ?? (cancelled ? 'Cancelled by user.' : 'Run failed.'), validation_status: this.runs.findRequired(run.id).validationStatus ?? 'not_configured', external_session_id: result.externalSessionId, final_head_sha: finalGit.head, final_git_state: JSON.stringify(finalGit) });
      this.runs.appendEvent(run.id, 'terminal', { status, exitCode: result.exitCode, signal: result.signal });
      if (run.executionMode === 'sequential_batch') this.runs.appendEvent(run.id, batchTerminalEvent(status), { status });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error); const current = this.runs.findRequired(run.id);
      if (current.status === 'cancel_requested') {
        this.runs.setStatus(run.id, 'cancelled', { finished_at: new Date().toISOString(), failure_reason: 'Cancelled by user.' });
        this.runs.appendEvent(run.id, 'terminal', { status: 'cancelled' });
        if (!isFollowUp) this.tasks.setStatus(task.id, 'cancelled');
        return;
      }
      if (current.status === 'timed_out' && current.worktreePath) {
        const finalGit = await inspectGit(current.worktreePath);
        this.runs.setStatus(run.id, 'timed_out', { final_head_sha: finalGit.head, final_git_state: JSON.stringify(finalGit) });
      }
      if (!terminalStatuses.has(current.status)) { const timedOut = Date.now() >= (current.startedAt ? new Date(current.startedAt).getTime() + this.defaults.timeoutMs : Number.MAX_SAFE_INTEGER); this.runs.setStatus(run.id, timedOut ? 'timed_out' : 'blocked', { finished_at: new Date().toISOString(), failure_reason: timedOut ? 'Run exceeded the hard timeout.' : detail }); this.runs.appendEvent(run.id, timedOut ? 'timeout' : 'blocked', { detail }); }
      if (run.executionMode === 'sequential_batch') this.runs.appendEvent(run.id, batchTerminalEvent(this.runs.findRequired(run.id).status), { status: this.runs.findRequired(run.id).status, detail });
      if (!isFollowUp) this.tasks.setStatus(task.id, taskStatus(this.runs.findRequired(run.id).status));
    } finally { this.active.delete(run.id); }
  }
  private followUpBase(sourceRunId: string): GitCommandResult {
    const source = this.runs.findRequired(sourceRunId);
    if (source.candidatePublishState !== 'published' || !source.candidateCommitSha) throw new Error('Follow-up Run source has no published candidate.');
    return { stdout: `${source.candidateCommitSha}\n`, stderr: '', exitCode: 0 };
  }
  private async publishCandidateInternal(runId: string): Promise<Run> {
    try {
      let run = this.runs.findRequired(runId);
      if (run.status !== 'completed') throw new Error('Only completed Runs can publish a candidate.');
      const workspace = this.workspaces.findById(run.workspaceId);
      if (!workspace?.isGit || !run.worktreePath) throw new Error('This Run has no publishable Git worktree.');
      const worktreePath = run.worktreePath;
      const [worktreeRoot, worktreeGitDir, workspaceGitDir] = await Promise.all([
        runGit(worktreePath, ['rev-parse', '--show-toplevel']),
        runGit(worktreePath, ['rev-parse', '--git-common-dir']),
        runGit(workspace.rootPath, ['rev-parse', '--git-common-dir']),
      ]);
      if (worktreeRoot.exitCode !== 0 || worktreeGitDir.exitCode !== 0 || workspaceGitDir.exitCode !== 0 || resolve(worktreePath) !== resolve(worktreeRoot.stdout.trim()) || resolve(worktreePath, worktreeGitDir.stdout.trim()) !== resolve(workspace.rootPath, workspaceGitDir.stdout.trim())) throw new Error('Recorded Run worktree does not belong to its Workspace repository.');
      const task = this.tasks.findById(run.taskId); const branchName = candidateBranchName(run.id, task?.title ?? 'candidate');
      if (!run.candidateCommitSha) {
        const branch = await runGit(worktreePath, ['rev-parse', '--verify', `refs/heads/${branchName}`]);
        const currentBranch = await runGit(worktreePath, ['branch', '--show-current']);
        if (branch.exitCode === 0) {
          const message = await runGit(worktreePath, ['log', '-1', '--format=%s', branchName]);
          if (currentBranch.stdout.trim() !== branchName) throw new Error(`Candidate branch ${branchName} already exists and is not owned by this Run.`);
          if (message.stdout.trim() === `NightShift candidate: ${run.id}`) {
            const parent = await runGit(worktreePath, ['rev-parse', '--verify', `${branchName}^`]);
            if (parent.exitCode !== 0 || parent.stdout.trim() !== run.baseSha) throw new Error(`Candidate branch ${branchName} does not match this Run base.`);
            run = this.runs.setCandidateCommit(run.id, branchName, branch.stdout.trim());
            this.runs.appendEvent(run.id, 'candidate_commit_recovered', { branchName, commitSha: run.candidateCommitSha });
          } else if (branch.stdout.trim() !== run.baseSha) {
            throw new Error(`Candidate branch ${branchName} already exists and is not owned by this Run.`);
          }
        }
        if (!run.candidateCommitSha) {
          const changes = await runGit(worktreePath, ['status', '--porcelain=v1']);
          if (changes.exitCode !== 0) throw new Error('Could not inspect candidate changes.');
          if (!changes.stdout.trim()) throw new Error('Cannot publish a candidate for a Run with no changes.');
          if (branch.exitCode === 0) {
            if (currentBranch.stdout.trim() !== branchName) throw new Error(`Candidate branch ${branchName} already exists and is not owned by this Run.`);
          } else {
            const created = await runGit(worktreePath, ['switch', '-c', branchName]);
            if (created.exitCode !== 0) throw new Error(gitFailure('Could not create candidate branch.', created));
          }
          const staged = await runGit(worktreePath, ['add', '-A']); if (staged.exitCode !== 0) throw new Error(gitFailure('Could not stage candidate changes.', staged));
          const committed = await runGit(worktreePath, ['commit', '-m', `NightShift candidate: ${run.id}`]); if (committed.exitCode !== 0) throw new Error(gitFailure('Could not create candidate commit.', committed));
          const sha = await runGit(worktreePath, ['rev-parse', '--verify', 'HEAD']); if (sha.exitCode !== 0) throw new Error('Could not determine candidate commit SHA.');
          run = this.runs.setCandidateCommit(run.id, branchName, sha.stdout.trim()); this.runs.appendEvent(run.id, 'candidate_committed', { branchName, commitSha: run.candidateCommitSha });
        }
      }
      if (run.candidatePublishState === 'published') return run;
      if (!run.candidateBranchName || !run.candidateCommitSha) throw new Error('Candidate commit metadata is incomplete.');
      const localCandidate = await runGit(worktreePath, ['rev-parse', '--verify', `refs/heads/${run.candidateBranchName}`]);
      if (localCandidate.exitCode !== 0 || localCandidate.stdout.trim() !== run.candidateCommitSha) throw new Error('Local candidate branch no longer matches the recorded candidate commit.');
      if (!this.runs.tryBeginCandidatePublish(run.id)) throw new Error('Candidate publishing is already in progress.');
      const remote = 'origin'; const remoteUrl = await runGit(worktreePath, ['remote', 'get-url', remote]);
      if (remoteUrl.exitCode !== 0) throw new Error('Candidate publishing requires the configured origin remote.');
      const remoteHead = await runGit(worktreePath, ['ls-remote', '--heads', remote, `refs/heads/${run.candidateBranchName}`]);
      const publishedSha = remoteHead.stdout.trim().split(/\s+/, 1)[0];
      if (publishedSha) {
        if (publishedSha !== run.candidateCommitSha) throw new Error(`Remote candidate branch ${run.candidateBranchName} already points to an incompatible commit.`);
        this.runs.appendEvent(run.id, 'candidate_publish_reused', { branchName: run.candidateBranchName, commitSha: run.candidateCommitSha, remote });
        return this.runs.setCandidatePublished(run.id, remote);
      }
      const pushed = await runGit(worktreePath, ['push', remote, `refs/heads/${run.candidateBranchName}:refs/heads/${run.candidateBranchName}`]);
      if (pushed.exitCode !== 0) throw new Error(gitFailure('Could not push candidate branch.', pushed));
      this.runs.appendEvent(run.id, 'candidate_published', { branchName: run.candidateBranchName, commitSha: run.candidateCommitSha, remote });
      return this.runs.setCandidatePublished(run.id, remote);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error); const run = this.runs.find(runId);
      if (run && !isNoChangeCandidatePublishError(detail)) this.runs.setCandidatePublishFailure(runId, detail);
      throw error;
    }
  }
  private async publishDelegatedCandidate(runId: string): Promise<void> {
    try {
      await this.publishCandidate(runId);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (isNoChangeCandidatePublishError(detail)) {
        this.runs.appendEvent(runId, 'candidate_publish_skipped', { state: 'not_applicable', reason: 'Delegated Leader Run completed without Git changes.' });
        return;
      }
      this.runs.appendEvent(runId, 'candidate_publish_failed', { detail, retryAvailable: true });
    }
  }
  private async executeSingle(runId: string, workspaceId: string, workingDirectory: string, modelId: string, adapter: AgentAdapter, prompt: string, deadline: number): Promise<AgentExecutionResult> {
    const handle = await adapter.startRun({ runId, workspaceId, workingDirectory, modelId, prompt, onProtocolEvent: (event) => this.runs.appendEvent(runId, 'agent_protocol', event, event.timestamp) });
    this.active.set(runId, { cancel: () => adapter.cancel(handle.handleId), timedOut: false });
    if (this.runs.findRequired(runId).status === 'cancel_requested') await adapter.cancel(handle.handleId);
    return this.waitWithTimeout(runId, handle.completion, Math.max(0, deadline - Date.now()));
  }
  private async executeBatch(runId: string, workspaceId: string, workingDirectory: string, modelId: string, adapter: AgentAdapter, sharedPrompt: string, steps: readonly BatchStep[], deadline: number): Promise<AgentExecutionResult> {
    this.runs.appendEvent(runId, 'batch_started', { stepCount: steps.length });
    let lastResult: AgentExecutionResult | undefined;
    for (const step of steps) {
      if (this.runs.findRequired(runId).status === 'cancel_requested') {
        this.cancelPendingSteps(steps, step.stepIndex);
        return cancelledResult();
      }
      this.runs.setBatchStepStatus(step.id, 'running', { started_at: new Date().toISOString() });
      this.runs.appendEvent(runId, 'batch_step_started', { stepIndex: step.stepIndex, prompt: step.prompt });
      try {
        if (deadline <= Date.now()) { await this.timeoutRun(runId, Promise.resolve()); throw new RunTimeoutError(); }
        const prompt = sharedPrompt ? `Shared batch context:\n${sharedPrompt}\n\nCurrent ordered step:\n${step.prompt}` : step.prompt;
        const handle = await adapter.startRun({ runId, workspaceId, workingDirectory, modelId, prompt, onProtocolEvent: (event) => this.runs.appendEvent(runId, 'agent_protocol', { stepIndex: step.stepIndex, event }, event.timestamp) });
        this.active.set(runId, { cancel: () => adapter.cancel(handle.handleId), timedOut: false });
        if (this.runs.findRequired(runId).status === 'cancel_requested') await adapter.cancel(handle.handleId);
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) { await this.timeoutRun(runId, handle.completion); throw new RunTimeoutError(); }
        const result = await this.waitWithTimeout(runId, handle.completion, remainingMs);
        lastResult = result;
        const cancelled = this.runs.findRequired(runId).status === 'cancel_requested';
        const status = cancelled ? 'cancelled' : result.succeeded ? 'completed' : 'failed';
        this.runs.setBatchStepStatus(step.id, status, { finished_at: new Date().toISOString(), external_session_id: result.externalSessionId, result_summary: result.terminalEvent?.raw ?? null, failure_reason: status === 'completed' ? null : result.failureReason ?? (cancelled ? 'Cancelled by user.' : 'Batch step failed.') });
        this.runs.appendEvent(runId, status === 'completed' ? 'batch_step_completed' : status === 'cancelled' ? 'batch_step_cancelled' : 'batch_step_failed', { stepIndex: step.stepIndex, status });
        if (status !== 'completed') { this.cancelPendingSteps(steps, step.stepIndex + 1); return result; }
      } catch (error) {
        const timedOut = this.runs.findRequired(runId).status === 'timed_out';
        const detail = error instanceof Error ? error.message : String(error);
        this.runs.setBatchStepStatus(step.id, timedOut ? 'timed_out' : 'failed', { finished_at: new Date().toISOString(), failure_reason: detail });
        this.runs.appendEvent(runId, timedOut ? 'batch_step_timed_out' : 'batch_step_failed', { stepIndex: step.stepIndex, detail, timedOut });
        this.cancelPendingSteps(steps, step.stepIndex + 1); throw error;
      } finally { this.active.delete(runId); }
    }
    return lastResult ?? cancelledResult();
  }
  private cancelPendingSteps(steps: readonly BatchStep[], fromIndex: number, reason = 'Not started because the batch did not complete.'): void {
    steps.filter((step) => step.stepIndex >= fromIndex).forEach((step) => this.runs.setBatchStepStatus(step.id, 'cancelled', { finished_at: new Date().toISOString(), failure_reason: reason }));
  }
  private async finalizeIfCancellationRequested(runId: string, taskId: string, batchSteps: readonly BatchStep[] = []): Promise<boolean> {
    const run = this.runs.findRequired(runId);
    if (run.status !== 'cancel_requested') return false;
    const finalGit = run.worktreePath ? await inspectGit(run.worktreePath) : null;
    this.runs.setStatus(runId, 'cancelled', {
      finished_at: new Date().toISOString(),
      failure_reason: 'Cancelled before agent execution.',
      validation_status: 'not_configured',
      final_head_sha: finalGit?.head ?? null,
      final_git_state: finalGit ? JSON.stringify(finalGit) : null,
    });
    this.runs.appendEvent(runId, 'terminal', { status: 'cancelled', beforeAgentExecution: true });
    if (batchSteps.length) {
      this.cancelPendingSteps(batchSteps, 0, 'Cancelled before agent execution.');
      this.runs.appendEvent(runId, 'batch_cancelled', { beforeAgentExecution: true });
    }
    if (!run.sourceRunId) this.tasks.setStatus(taskId, 'cancelled');
    return true;
  }
  private async waitWithTimeout(runId: string, completion: Promise<AgentExecutionResult>, timeoutMs = this.defaults.timeoutMs): Promise<AgentExecutionResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([completion, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new RunTimeoutError()), timeoutMs); })]); }
    catch (error) { if (!(error instanceof RunTimeoutError)) throw error; await this.timeoutRun(runId, completion); throw error; }
    finally { if (timer) clearTimeout(timer); }
  }
  private async timeoutRun(runId: string, completion: Promise<unknown>): Promise<void> {
    this.runs.setStatus(runId, 'timed_out', { finished_at: new Date().toISOString(), failure_reason: 'Run exceeded the hard timeout.' }); this.runs.appendEvent(runId, 'timeout', {});
    const active = this.active.get(runId); if (active) { active.timedOut = true; await active.cancel(); await completion.catch(() => undefined); }
  }
  private async plannerBase(rootPath: string, workspaceId: string): Promise<GitCommandResult> {
    const sha = await resolveEffectiveDevBase(rootPath, workspaceId, this.settings);
    return { stdout: `${sha}\n`, stderr: '', exitCode: 0 };
  }
}
const taskStatus = (status: RunStatus): 'completed' | 'failed' | 'blocked' | 'cancelled' => status === 'completed' ? 'completed' : status === 'cancelled' ? 'cancelled' : status === 'timed_out' ? 'failed' : status === 'failed' ? 'failed' : 'blocked';
class RunTimeoutError extends Error {}
const cancelledResult = (): AgentExecutionResult => ({ handleId: 'cancelled-before-step', succeeded: false, failureReason: 'Cancelled by user.', exitCode: null, signal: null, externalSessionId: null, events: [], terminalEvent: null, stderr: '' });
const batchTerminalEvent = (status: RunStatus): string => status === 'completed' ? 'batch_completed' : status === 'cancelled' ? 'batch_cancelled' : status === 'timed_out' ? 'batch_timed_out' : 'batch_failed';
const inspectGit = async (path: string): Promise<{ head: string | null; status: string; diffStat: string }> => { const [head, status, diffStat] = await Promise.all([runGit(path, ['rev-parse', 'HEAD']), runGit(path, ['status', '--porcelain=v1']), runGit(path, ['diff', '--stat'])]); return { head: head.exitCode === 0 ? head.stdout.trim() : null, status: status.stdout, diffStat: diffStat.stdout }; };
const followUpPrompt = (prompt: string, correctivePrompt: string | null): string => correctivePrompt ? `${prompt}\n\nFollow-up corrective instruction:\n${correctivePrompt}` : prompt;
const candidateBranchName = (runId: string, title: string): string => {
  const slug = title.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'candidate';
  return `nightshift/run/${runId}-${slug}`;
};
const gitFailure = (prefix: string, result: GitCommandResult): string => `${prefix} ${result.stderr.trim() || result.stdout.trim() || 'Git returned an error.'}`;
const isNoChangeCandidatePublishError = (detail: string): boolean => detail === 'Cannot publish a candidate for a Run with no changes.';
const normalizeConcurrency = (value: unknown): number => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 4 ? value : 2;
