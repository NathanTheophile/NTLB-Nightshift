import type { AgentAdapter, AgentExecutionResult } from './contracts/AgentAdapter';
import type { RunService as RunServiceContract } from './contracts/RunService';
import { runGit, type GitCommand, type GitCommandResult } from './GitWorktreeService';
import { assertNodeValidationDependencies, ProjectValidationService } from './ProjectValidationService';
import { WindowsProcessSupervisor } from './WindowsProcessSupervisor';
import type { ProcessSupervisor } from './contracts/ProcessSupervisor';
import type { WorktreeService } from './contracts/WorktreeService';
import type { RunArtifactCleaner } from './contracts/RunArtifactCleaner';
import type { PlannerTaskRepository } from '../persistence/repositories/PlannerTaskRepository';
import type { RunRepository } from '../persistence/repositories/RunRepository';
import type { WorkspaceRepository } from '../persistence/repositories/WorkspaceRepository';
import type { SettingsRepository } from '../persistence/repositories/SettingsRepository';
import type { BatchStep, Run, RunEventKind, RunStatus } from '@shared/domain/entities';
import type { RunNavigationItem } from '@shared/contracts/ipc';
import { basename, resolve } from 'node:path';
import { resolveEffectiveDevBase } from './ReviewIntegrationService';
import { candidateBranchForRunName } from './RunNaming';

const terminalStatuses = new Set<RunStatus>(['completed', 'failed', 'blocked', 'cancelled', 'timed_out']);
const CANDIDATE_GIT_TIMEOUT_MS = 3 * 60_000;
const MAX_AUTOMATIC_CORRECTIONS = 2;
const MAX_INITIAL_AGENT_RECOVERIES = 1;
const PROVIDER_RETRY_DELAYS_MS = [60_000, 120_000] as const;
const MAX_CORRECTION_EVIDENCE_CHARS = 12_000;
const MAX_CORRECTION_DIAGNOSTIC_BYTES = 4 * 1024;
const candidateGitOptions = (timeoutMs: number) => ({ timeoutMs, environment: { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' } });

export interface PlannerRunDefaults { agentId: string; modelId: string; timeoutMs: number; }
export interface RunTiming { sleep(milliseconds: number, signal: AbortSignal): Promise<void>; }
export class RunService implements RunServiceContract {
  private readonly active = new Map<string, { cancel: () => Promise<void>; timedOut: boolean }>();
  private readonly publishing = new Map<string, Promise<Run>>();
  private readonly followUpQueue: string[] = [];
  private readonly validation: ProjectValidationService;
  private readonly slots = new Map<string, Promise<void>>();
  private configuredConcurrency: number | undefined;
  private configuredTimeoutMs: number | undefined;
  private scheduling = false;
  private scheduleRequested = false;
  public constructor(private readonly runs: RunRepository, private readonly tasks: PlannerTaskRepository, private readonly workspaces: WorkspaceRepository, private readonly worktrees: WorktreeService, private readonly adapters: ReadonlyMap<string, AgentAdapter>, private readonly defaults: PlannerRunDefaults, validationSupervisor: ProcessSupervisor = new WindowsProcessSupervisor(), private readonly settings?: SettingsRepository, private readonly candidateGitTimeoutMs = CANDIDATE_GIT_TIMEOUT_MS, private readonly artifacts?: RunArtifactCleaner, private readonly git: GitCommand = runGit, private readonly timing: RunTiming = systemTiming) { this.validation = new ProjectValidationService(runs, validationSupervisor, git); }
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
  public timeoutMs(): number { return this.configuredTimeoutMs ?? normalizeTimeout(this.settings?.get<number>('planner.run_timeout_ms'), this.defaults.timeoutMs); }
  public setTimeoutMs(timeoutMs: number): number {
    const normalized = normalizeTimeout(timeoutMs, this.defaults.timeoutMs);
    if (timeoutMs !== normalized) throw new Error('Run timeout must be 30, 60, 90, or 120 minutes.');
    this.configuredTimeoutMs = normalized;
    this.settings?.set('planner.run_timeout_ms', normalized);
    return normalized;
  }
  public queuePaused(): boolean { return this.settings?.get<boolean>('planner.queue_paused') === true; }
  /** Narrow lifecycle signal for callers that must dispose resources after Run work settles. */
  public isIdle(): boolean { return !this.scheduling && !this.scheduleRequested && this.slots.size === 0 && this.active.size === 0 && this.publishing.size === 0; }
  public setQueuePaused(paused: boolean): boolean {
    this.settings?.set('planner.queue_paused', paused);
    if (!paused) this.schedule();
    return paused;
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
  public async purgePlannerTask(taskId: string): Promise<void> {
    const task = this.tasks.findById(taskId);
    if (!task) throw new Error(`Planner task ${taskId} was not found.`);
    if (!['completed', 'failed', 'blocked', 'cancelled'].includes(task.status)) throw new Error('Only terminal Planner tasks can be permanently deleted.');
    const history = this.runs.listByTask(taskId);
    if (history.some((run) => !terminalStatuses.has(run.status) || run.candidatePublishState === 'publishing' || this.active.has(run.id) || this.publishing.has(run.id) || this.slots.has(run.id))) {
      throw new Error('Planner task cannot be deleted while an associated Run is active.');
    }
    await this.artifacts?.removeForRuns(history);
    for (const run of history) {
      const workspace = this.workspaces.findById(run.workspaceId);
      if (run.worktreePath && workspace?.isGit) await this.worktrees.removeAfterEvidencePersisted(run.worktreePath, workspace.rootPath);
      await this.removeOwnedCandidateBranch(run, workspace?.rootPath);
    }
    this.tasks.transaction(() => {
      this.runs.deleteTaskHistory(taskId);
      this.tasks.deleteAfterRunPurge(taskId);
    });
  }
  private async removeOwnedCandidateBranch(run: Run, repositoryRoot: string | undefined): Promise<void> {
    if (!repositoryRoot || !run.worktreePath || !run.candidateBranchName || !run.candidateCommitSha
      || run.candidateBranchName !== candidateBranchForRunName(basename(run.worktreePath))) return;
    const ref = `refs/heads/${run.candidateBranchName}`;
    const [head, message] = await Promise.all([
      this.git(repositoryRoot, ['rev-parse', '--verify', ref]),
      this.git(repositoryRoot, ['log', '-1', '--format=%B', ref]),
    ]);
    if (head.exitCode !== 0) return;
    if (head.stdout.trim() !== run.candidateCommitSha || message.stdout.trim() !== `NightShift candidate: ${run.id}`) {
      console.warn(`[Planner] Preserving unproven local candidate branch ${run.candidateBranchName}.`);
      return;
    }
    const removed = await this.git(repositoryRoot, ['branch', '-D', run.candidateBranchName]);
    if (removed.exitCode !== 0) console.warn(`[Planner] Could not remove local candidate branch ${run.candidateBranchName}: ${removed.stderr.trim() || removed.stdout.trim()}`);
  }
  // Scheduling work is intentionally synchronous until the launched Run promises yield.
  // eslint-disable-next-line @typescript-eslint/require-await
  private async fillSlots(): Promise<void> {
    this.scheduling = true;
    try {
      do {
        this.scheduleRequested = false;
        if (this.queuePaused()) { this.scheduleRequested = false; break; }
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
    const agentId = run.resolvedAgentId; const modelId = run.resolvedModelId; const isFollowUp = Boolean(run.sourceRunId); const runTimeoutMs = this.timeoutMs();
    const batchSteps = run.executionMode === 'sequential_batch' ? this.runs.createBatchSteps(run.id, this.tasks.batchSteps(task.id)) : [];
    this.runs.appendEvent(run.id, 'preparing', { agentId, modelId, executionMode: run.executionMode });
    try {
      if (!workspace?.isGit) throw new Error('Write-capable Planner runs require a Git workspace.');
      const adapter = this.adapters.get(agentId); if (!adapter || !adapter.capabilities().plannerValidated) throw new Error(`Planner agent ${agentId} is not validated.`);
      if (adapter.supportsPlannerModel && !adapter.supportsPlannerModel(modelId)) throw new Error(`Planner model ${modelId} is not validated for ${agentId}.`);
      const head = run.sourceRunId ? this.followUpBase(run.sourceRunId) : await this.plannerBase(workspace.rootPath, workspace.id);
      if (head.exitCode !== 0) throw new Error('Could not determine Git base for Planner run.');
      if (await this.finalizeIfCancellationRequested(run.id, task.id, batchSteps)) return;
      await assertNodeValidationDependencies(workspace.rootPath);
      const worktree = await this.worktrees.createForRun({ runId: run.id, title: task.title, repositoryRoot: workspace.rootPath, baseSha: head.stdout.trim() });
      this.runs.setPreparation(run.id, worktree.baseSha, worktree.path); this.runs.appendEvent(run.id, 'worktree_created', worktree);
      if (await this.finalizeIfCancellationRequested(run.id, task.id, batchSteps)) return;
      this.runs.setStatus(run.id, 'running', { started_at: new Date().toISOString() }); this.runs.appendEvent(run.id, 'running', {});
      const deadline = Date.now() + runTimeoutMs;
      const effectivePrompt = followUpPrompt(task.prompt, run.followUpPrompt);
      const singleExecution = run.executionMode === 'single_agent'
        ? await this.executeSingleWithProviderRetries(run.id, workspace.id, worktree.path, modelId, adapter, effectivePrompt, deadline)
        : undefined;
      let result = run.executionMode === 'sequential_batch'
        ? await this.executeBatch(run.id, workspace.id, worktree.path, modelId, adapter, effectivePrompt, batchSteps, deadline)
        : singleExecution!.result;
      if (run.executionMode === 'single_agent' && !result.succeeded && !singleExecution!.providerRetriesExhausted) result = await this.recoverInitialAgentFailure(run.id, workspace.id, worktree.path, modelId, adapter, effectivePrompt, result, deadline);
      const current = this.runs.findRequired(run.id); const cancelled = current.status === 'cancel_requested';
      let status: RunStatus = current.status === 'timed_out' ? 'timed_out' : cancelled ? 'cancelled' : result.succeeded ? 'completed' : 'failed';
      if (status === 'completed') {
        const validationStatus = await this.validation.validate(run.id, worktree.path, { deadline, isCancellationRequested: () => this.runs.findRequired(run.id).status === 'cancel_requested', onProcessStarted: (cancel) => this.active.set(run.id, { cancel, timedOut: false }), onProcessFinished: () => this.active.delete(run.id) });
        const afterValidation = this.runs.findRequired(run.id);
        if (afterValidation.status === 'cancel_requested') status = 'cancelled';
        else if (validationStatus === 'failed' && run.executionMode === 'single_agent') {
          result = await this.correctValidationFailures(run.id, workspace.id, worktree.path, modelId, adapter, effectivePrompt, result, deadline);
          const correctedRun = this.runs.findRequired(run.id);
          status = correctedRun.status === 'timed_out' ? 'timed_out' : correctedRun.status === 'cancel_requested' ? 'cancelled' : result.succeeded ? 'completed' : 'failed';
        } else if (validationStatus === 'failed') status = 'failed';
        else if (validationStatus === 'interrupted' && Date.now() >= deadline) { status = 'timed_out'; this.runs.appendEvent(run.id, 'timeout', { phase: 'validation' }); }
      }
      const finalGit = await inspectGit(worktree.path, this.git);
      if (!isFollowUp) this.tasks.setStatus(task.id, taskStatus(status));
      this.runs.setStatus(run.id, status, { finished_at: new Date().toISOString(), exit_code: result.exitCode, result_summary: result.terminalEvent?.raw ?? null, failure_reason: status === 'completed' ? null : status === 'timed_out' ? 'Run exceeded the hard timeout.' : result.failureReason ?? (cancelled ? 'Cancelled by user.' : 'Run failed.'), validation_status: this.runs.findRequired(run.id).validationStatus ?? 'not_configured', external_session_id: result.externalSessionId, final_head_sha: finalGit.head, final_git_state: JSON.stringify(finalGit) });
      this.runs.appendEvent(run.id, 'terminal', { status, exitCode: result.exitCode, signal: result.signal });
      if (run.executionMode === 'sequential_batch') this.runs.appendEvent(run.id, batchTerminalEvent(status), { status });
      if (status === 'completed' && !isFollowUp && this.runs.findRequired(run.id).validationStatus === 'passed') await this.publishCandidateAutomatically(run.id, worktree.path);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error); const current = this.runs.findRequired(run.id);
      if (current.status === 'cancel_requested') {
        this.runs.setStatus(run.id, 'cancelled', { finished_at: new Date().toISOString(), failure_reason: 'Cancelled by user.' });
        this.runs.appendEvent(run.id, 'terminal', { status: 'cancelled' });
        if (!isFollowUp) this.tasks.setStatus(task.id, 'cancelled');
        return;
      }
      if (current.status === 'timed_out' && current.worktreePath) {
        const finalGit = await inspectGit(current.worktreePath, this.git);
        this.runs.setStatus(run.id, 'timed_out', { final_head_sha: finalGit.head, final_git_state: JSON.stringify(finalGit) });
      }
      if (!terminalStatuses.has(current.status)) { const timedOut = Date.now() >= (current.startedAt ? new Date(current.startedAt).getTime() + runTimeoutMs : Number.MAX_SAFE_INTEGER); this.runs.setStatus(run.id, timedOut ? 'timed_out' : 'blocked', { finished_at: new Date().toISOString(), failure_reason: timedOut ? 'Run exceeded the hard timeout.' : detail }); this.runs.appendEvent(run.id, timedOut ? 'timeout' : 'blocked', { detail }); }
      if (run.executionMode === 'sequential_batch') this.runs.appendEvent(run.id, batchTerminalEvent(this.runs.findRequired(run.id).status), { status: this.runs.findRequired(run.id).status, detail });
      if (!isFollowUp) this.tasks.setStatus(task.id, taskStatus(this.runs.findRequired(run.id).status));
    } finally { this.active.delete(run.id); }
  }
  private async publishCandidateAutomatically(runId: string, worktreePath: string): Promise<void> {
    const changes = await this.git(worktreePath, ['status', '--porcelain=v1']);
    if (changes.exitCode !== 0) {
      this.runs.setCandidatePublishFailure(runId, 'Could not inspect candidate changes.');
      this.runs.appendEvent(runId, 'candidate_publish_failed', { reason: 'Could not inspect candidate changes.' });
      return;
    }
    if (!changes.stdout.trim()) {
      this.runs.appendEvent(runId, 'candidate_not_required', { reason: 'Run completed with no changes.' });
      return;
    }
    try { await this.publishCandidate(runId); }
    catch (error) { this.runs.appendEvent(runId, 'candidate_publish_failed', { reason: error instanceof Error ? error.message : String(error) }); }
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
        this.git(worktreePath, ['rev-parse', '--show-toplevel']),
        this.git(worktreePath, ['rev-parse', '--git-common-dir']),
        this.git(workspace.rootPath, ['rev-parse', '--git-common-dir']),
      ]);
      if (worktreeRoot.exitCode !== 0 || worktreeGitDir.exitCode !== 0 || workspaceGitDir.exitCode !== 0 || resolve(worktreePath) !== resolve(worktreeRoot.stdout.trim()) || resolve(worktreePath, worktreeGitDir.stdout.trim()) !== resolve(workspace.rootPath, workspaceGitDir.stdout.trim())) throw new Error('Recorded Run worktree does not belong to its Workspace repository.');
      const branchName = candidateBranchForRunName(basename(worktreePath));
      if (!run.candidateCommitSha) {
        const branch = await this.git(worktreePath, ['rev-parse', '--verify', `refs/heads/${branchName}`]);
        const currentBranch = await this.git(worktreePath, ['branch', '--show-current']);
        if (branch.exitCode === 0) {
          const message = await this.git(worktreePath, ['log', '-1', '--format=%s', branchName]);
          if (currentBranch.stdout.trim() !== branchName) throw new Error(`Candidate branch ${branchName} already exists and is not owned by this Run.`);
          if (message.stdout.trim() === `NightShift candidate: ${run.id}`) {
            const parent = await this.git(worktreePath, ['rev-parse', '--verify', `${branchName}^`]);
            if (parent.exitCode !== 0 || parent.stdout.trim() !== run.baseSha) throw new Error(`Candidate branch ${branchName} does not match this Run base.`);
            run = this.runs.setCandidateCommit(run.id, branchName, branch.stdout.trim());
            this.runs.appendEvent(run.id, 'candidate_commit_recovered', { branchName, commitSha: run.candidateCommitSha });
          } else if (branch.stdout.trim() !== run.baseSha) {
            throw new Error(`Candidate branch ${branchName} already exists and is not owned by this Run.`);
          }
        }
        if (!run.candidateCommitSha) {
          const changes = await this.git(worktreePath, ['status', '--porcelain=v1']);
          if (changes.exitCode !== 0) throw new Error('Could not inspect candidate changes.');
          if (!changes.stdout.trim()) throw new Error('Cannot publish a candidate for a Run with no changes.');
          if (branch.exitCode === 0) {
            if (currentBranch.stdout.trim() !== branchName) throw new Error(`Candidate branch ${branchName} already exists and is not owned by this Run.`);
          } else {
            const created = await this.git(worktreePath, ['switch', '-c', branchName]);
            if (created.exitCode !== 0) throw new Error(gitFailure('Could not create candidate branch.', created));
          }
          const staged = await this.git(worktreePath, ['add', '-A']); if (staged.exitCode !== 0) throw new Error(gitFailure('Could not stage candidate changes.', staged));
          const committed = await this.git(worktreePath, ['commit', '-m', `NightShift candidate: ${run.id}`]); if (committed.exitCode !== 0) throw new Error(gitFailure('Could not create candidate commit.', committed));
          const sha = await this.git(worktreePath, ['rev-parse', '--verify', 'HEAD']); if (sha.exitCode !== 0) throw new Error('Could not determine candidate commit SHA.');
          run = this.runs.setCandidateCommit(run.id, branchName, sha.stdout.trim()); this.runs.appendEvent(run.id, 'candidate_committed', { branchName, commitSha: run.candidateCommitSha });
        }
      }
      if (run.candidatePublishState === 'published') return run;
      if (!run.candidateBranchName || !run.candidateCommitSha) throw new Error('Candidate commit metadata is incomplete.');
      const localCandidate = await this.git(worktreePath, ['rev-parse', '--verify', `refs/heads/${run.candidateBranchName}`]);
      if (localCandidate.exitCode !== 0 || localCandidate.stdout.trim() !== run.candidateCommitSha) throw new Error('Local candidate branch no longer matches the recorded candidate commit.');
      if (!this.runs.tryBeginCandidatePublish(run.id)) throw new Error('Candidate publishing is already in progress.');
      const remote = 'origin'; const remoteUrl = await this.git(worktreePath, ['remote', 'get-url', remote]);
      if (remoteUrl.exitCode !== 0) throw new Error('Candidate publishing requires the configured origin remote.');
      const remoteHead = await this.git(worktreePath, ['ls-remote', '--heads', remote, `refs/heads/${run.candidateBranchName}`], candidateGitOptions(this.candidateGitTimeoutMs));
      if (remoteHead.exitCode !== 0) throw new Error(gitFailure('Could not inspect remote candidate branch.', remoteHead));
      const publishedSha = remoteHead.stdout.trim().split(/\s+/, 1)[0];
      if (publishedSha) {
        if (publishedSha !== run.candidateCommitSha) throw new Error(`Remote candidate branch ${run.candidateBranchName} already points to an incompatible commit.`);
        this.runs.appendEvent(run.id, 'candidate_publish_reused', { branchName: run.candidateBranchName, commitSha: run.candidateCommitSha, remote });
        return this.runs.setCandidatePublished(run.id, remote);
      }
      const pushed = await this.git(worktreePath, ['push', remote, `refs/heads/${run.candidateBranchName}:refs/heads/${run.candidateBranchName}`], candidateGitOptions(this.candidateGitTimeoutMs));
      if (pushed.exitCode !== 0) throw new Error(gitFailure('Could not push candidate branch.', pushed));
      this.runs.appendEvent(run.id, 'candidate_published', { branchName: run.candidateBranchName, commitSha: run.candidateCommitSha, remote });
      return this.runs.setCandidatePublished(run.id, remote);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error); const run = this.runs.find(runId);
      if (run?.status === 'completed') this.runs.setCandidatePublishFailure(runId, detail);
      throw error;
    }
  }
  private async executeSingle(runId: string, workspaceId: string, workingDirectory: string, modelId: string, adapter: AgentAdapter, prompt: string, deadline: number, externalSessionId: string | null = null): Promise<AgentExecutionResult> {
    const handle = await adapter.startRun({ runId, workspaceId, workingDirectory, modelId, prompt, externalSessionId, onProtocolEvent: (event) => this.runs.appendEvent(runId, 'agent_protocol', event, event.timestamp) });
    this.active.set(runId, { cancel: () => adapter.cancel(handle.handleId), timedOut: false });
    if (this.runs.findRequired(runId).status === 'cancel_requested') await adapter.cancel(handle.handleId);
    return this.waitWithTimeout(runId, handle.completion, Math.max(0, deadline - Date.now()));
  }
  private async executeSingleWithProviderRetries(runId: string, workspaceId: string, workingDirectory: string, modelId: string, adapter: AgentAdapter, originalPrompt: string, deadline: number): Promise<{ result: AgentExecutionResult; providerRetriesExhausted: boolean }> {
    let result = await this.executeSingle(runId, workspaceId, workingDirectory, modelId, adapter, originalPrompt, deadline);
    let externalSessionId = result.externalSessionId;
    for (let retryIndex = 0; retryIndex < PROVIDER_RETRY_DELAYS_MS.length && isTransientProviderFailure(result); retryIndex += 1) {
      const attempt = retryIndex + 1;
      const delayMs = PROVIDER_RETRY_DELAYS_MS[retryIndex]!;
      const run = this.runs.findRequired(runId);
      if (run.status === 'cancel_requested' || run.status === 'timed_out') return { result, providerRetriesExhausted: false };
      if (Date.now() >= deadline) { await this.timeoutRun(runId, Promise.resolve()); return { result, providerRetriesExhausted: false }; }
      this.runs.appendEvent(runId, 'provider_retry_scheduled', { attempt, delayMs, reason: transientProviderFailureKind(result) });
      const waitOutcome = await this.waitForProviderRetry(runId, Math.min(delayMs, Math.max(0, deadline - Date.now())), deadline);
      if (waitOutcome !== 'elapsed') return { result: waitOutcome === 'cancelled' ? cancelledResult() : result, providerRetriesExhausted: false };
      const priorExternalSessionId = externalSessionId;
      const resumed = Boolean(priorExternalSessionId && adapter.capabilities().resume);
      this.runs.appendEvent(runId, 'provider_retry_started', { attempt, resumed });
      result = await this.executeSingle(runId, workspaceId, workingDirectory, modelId, adapter, providerRetryPrompt(), deadline, resumed ? priorExternalSessionId : null);
      externalSessionId = result.externalSessionId ?? externalSessionId;
      if (result.succeeded) {
        this.runs.appendEvent(runId, 'provider_retry_completed', { attempt, resumed });
        return { result: { ...result, externalSessionId }, providerRetriesExhausted: false };
      }
    }
    if (isTransientProviderFailure(result)) {
      this.runs.appendEvent(runId, 'provider_retry_exhausted', { retries: PROVIDER_RETRY_DELAYS_MS.length, reason: transientProviderFailureKind(result) });
      return { result: { ...result, failureReason: `Provider unavailable or rate-limited after ${PROVIDER_RETRY_DELAYS_MS.length} retry attempts. Please try the Run again later.` }, providerRetriesExhausted: true };
    }
    return { result, providerRetriesExhausted: false };
  }
  private async waitForProviderRetry(runId: string, delayMs: number, deadline: number): Promise<'elapsed' | 'cancelled' | 'timed_out'> {
    let interrupt!: (outcome: 'cancelled' | 'timed_out') => void;
    const interrupted = new Promise<'cancelled' | 'timed_out'>((resolve) => { interrupt = resolve; });
    const abortController = new AbortController();
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    this.active.set(runId, { timedOut: false, cancel: () => { interrupt('cancelled'); abortController.abort(); return Promise.resolve(); } });
    try {
      const remainingMs = Math.max(0, deadline - Date.now());
      const deadlineReached = new Promise<'timed_out'>((resolve) => { deadlineTimer = setTimeout(() => resolve('timed_out'), remainingMs); });
      const outcome = await Promise.race([this.timing.sleep(delayMs, abortController.signal).then(() => 'elapsed' as const), interrupted, deadlineReached]);
      if (outcome === 'timed_out') await this.timeoutRun(runId, Promise.resolve());
      return outcome;
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      this.active.delete(runId);
    }
  }
  private async recoverInitialAgentFailure(runId: string, workspaceId: string, workingDirectory: string, modelId: string, adapter: AgentAdapter, originalPrompt: string, initialResult: AgentExecutionResult, deadline: number): Promise<AgentExecutionResult> {
    this.runs.appendEvent(runId, 'agent_execution_failed', executionFailureEvidence(adapter.id, initialResult));
    const run = this.runs.findRequired(runId);
    if (run.status === 'cancel_requested' || run.status === 'timed_out') return initialResult;
    if (Date.now() >= deadline) { await this.timeoutRun(runId, Promise.resolve()); return initialResult; }
    const attempt = MAX_INITIAL_AGENT_RECOVERIES;
    const priorExternalSessionId = initialResult.externalSessionId;
    const resumed = Boolean(priorExternalSessionId && adapter.capabilities().resume);
    this.runs.appendEvent(runId, 'agent_recovery_started', { attempt, resumed, priorExternalSessionId });
    const result = await this.executeSingle(runId, workspaceId, workingDirectory, modelId, adapter, initialRecoveryPrompt(originalPrompt, initialResult), deadline, resumed ? priorExternalSessionId : null);
    const current = this.runs.findRequired(runId);
    if (current.status === 'cancel_requested' || current.status === 'timed_out') return result;
    if (result.succeeded) {
      this.runs.appendEvent(runId, 'agent_recovery_completed', { attempt, resumed, externalSessionId: result.externalSessionId ?? priorExternalSessionId });
      return { ...result, externalSessionId: result.externalSessionId ?? priorExternalSessionId };
    }
    this.runs.appendEvent(runId, 'agent_recovery_failed', { attempt, resumed, priorExternalSessionId, ...executionFailureEvidence(adapter.id, result, priorExternalSessionId) });
    return { ...result, failureReason: `Automatic recovery after initial agent failure also failed: ${result.failureReason ?? 'Agent execution failed.'}. See agent_recovery_failed activity evidence for details.` };
  }
  private async correctValidationFailures(runId: string, workspaceId: string, workingDirectory: string, modelId: string, adapter: AgentAdapter, originalPrompt: string, initialResult: AgentExecutionResult, deadline: number): Promise<AgentExecutionResult> {
    let result = initialResult;
    let externalSessionId = initialResult.externalSessionId;
    for (let attempt = 1; attempt <= MAX_AUTOMATIC_CORRECTIONS; attempt += 1) {
      const run = this.runs.findRequired(runId);
      if (run.status === 'cancel_requested') return cancelledResult();
      if (Date.now() >= deadline) { await this.timeoutRun(runId, Promise.resolve()); throw new RunTimeoutError(); }
      const evidence = this.latestFailedValidationEvidence(runId);
      const priorExternalSessionId = externalSessionId;
      const resumed = Boolean(priorExternalSessionId && adapter.capabilities().resume);
      this.runs.appendEvent(runId, 'correction_started', { attempt, resumed });
      result = await this.executeSingle(runId, workspaceId, workingDirectory, modelId, adapter, correctionPrompt(originalPrompt, evidence), deadline, resumed ? priorExternalSessionId : null);
      externalSessionId = result.externalSessionId ?? externalSessionId;
      const current = this.runs.findRequired(runId);
      if (current.status === 'cancel_requested') return cancelledResult();
      if (!result.succeeded) {
        this.runs.appendEvent(runId, 'correction_failed', correctionFailureEvidence(attempt, resumed, priorExternalSessionId, adapter.id, result));
        return { ...result, failureReason: `Automatic correction attempt ${attempt} failed: ${result.failureReason ?? 'Agent execution failed.'} See correction_failed activity evidence for stderr/terminal details.` };
      }
      this.runs.appendEvent(runId, 'correction_completed', { attempt, externalSessionId });
      const validationStatus = await this.validation.validate(runId, workingDirectory, { deadline, isCancellationRequested: () => this.runs.findRequired(runId).status === 'cancel_requested', onProcessStarted: (cancel) => this.active.set(runId, { cancel, timedOut: false }), onProcessFinished: () => this.active.delete(runId) });
      const afterValidation = this.runs.findRequired(runId);
      if (afterValidation.status === 'cancel_requested') return cancelledResult();
      if (validationStatus === 'passed' || validationStatus === 'not_configured') return result;
      if (validationStatus === 'interrupted') {
        if (Date.now() >= deadline) { this.runs.appendEvent(runId, 'timeout', { phase: 'validation' }); await this.timeoutRun(runId, Promise.resolve()); throw new RunTimeoutError(); }
        return cancelledResult();
      }
    }
    return { ...result, succeeded: false, failureReason: `Deterministic validation remained failing after ${MAX_AUTOMATIC_CORRECTIONS} automatic correction attempts.` };
  }
  private latestFailedValidationEvidence(runId: string): { command: string; exitCode: number | null; output: string; outputTruncated: boolean } {
    const failed = this.runs.validationCommands(runId).filter((command) => command.status === 'failed').at(-1);
    if (!failed) throw new Error('No failed validation evidence is available for automatic correction.');
    return { command: failed.command, exitCode: failed.exitCode, output: failed.output, outputTruncated: failed.outputTruncated };
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
    const finalGit = run.worktreePath ? await inspectGit(run.worktreePath, this.git) : null;
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
  private async waitWithTimeout(runId: string, completion: Promise<AgentExecutionResult>, timeoutMs: number): Promise<AgentExecutionResult> {
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
    const sha = await resolveEffectiveDevBase(rootPath, workspaceId, this.settings, this.git);
    return { stdout: `${sha}\n`, stderr: '', exitCode: 0 };
  }
}
const taskStatus = (status: RunStatus): 'completed' | 'failed' | 'blocked' | 'cancelled' => status === 'completed' ? 'completed' : status === 'cancelled' ? 'cancelled' : status === 'timed_out' ? 'failed' : status === 'failed' ? 'failed' : 'blocked';
class RunTimeoutError extends Error {}
const systemTiming: RunTiming = { sleep: (milliseconds, signal) => new Promise((resolve) => {
  const timer = setTimeout(resolve, milliseconds);
  signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
}) };
const transientProviderFailurePatterns: ReadonlyArray<[RegExp, string]> = [
  [/\b(?:http\s*)?429\b/i, 'http_429'],
  [/\brate[ _-]?limit(?:ed)?\b/i, 'rate_limit'],
  [/\breadtimeout\b/i, 'read_timeout'],
  [/\btimeouterror\b/i, 'timeout_error'],
  [/\bsslwantreaderror\b/i, 'ssl_want_read'],
  [/\bprovider\b[^\n]{0,80}\bdeadline\s+exceeded\b/i, 'provider_deadline'],
];
const transientProviderFailureText = (result: AgentExecutionResult): string => [result.failureReason, result.stderr, result.terminalEvent?.raw, result.terminalEvent ? safeJson(result.terminalEvent.parsed) : ''].filter(Boolean).join('\n');
const transientProviderFailureKind = (result: AgentExecutionResult): string | null => transientProviderFailurePatterns.find(([pattern]) => pattern.test(transientProviderFailureText(result)))?.[1] ?? null;
const isTransientProviderFailure = (result: AgentExecutionResult): boolean => transientProviderFailureKind(result) !== null;
const cancelledResult = (): AgentExecutionResult => ({ handleId: 'cancelled-before-step', succeeded: false, failureReason: 'Cancelled by user.', exitCode: null, signal: null, externalSessionId: null, events: [], terminalEvent: null, stderr: '' });
const batchTerminalEvent = (status: RunStatus): string => status === 'completed' ? 'batch_completed' : status === 'cancelled' ? 'batch_cancelled' : status === 'timed_out' ? 'batch_timed_out' : 'batch_failed';
const inspectGit = async (path: string, git: GitCommand = runGit): Promise<{ head: string | null; status: string; diffStat: string }> => { const [head, status, diffStat] = await Promise.all([git(path, ['rev-parse', 'HEAD']), git(path, ['status', '--porcelain=v1']), git(path, ['diff', '--stat'])]); return { head: head.exitCode === 0 ? head.stdout.trim() : null, status: status.stdout, diffStat: diffStat.stdout }; };
const boundedDiagnostic = (value: string): { value: string; truncated: boolean } => {
  const bytes = Buffer.byteLength(value);
  return { value: bytes > MAX_CORRECTION_DIAGNOSTIC_BYTES ? Buffer.from(value).subarray(0, MAX_CORRECTION_DIAGNOSTIC_BYTES).toString('utf8') : value, truncated: bytes > MAX_CORRECTION_DIAGNOSTIC_BYTES };
};
const executionFailureEvidence = (adapterId: string, result: AgentExecutionResult, priorExternalSessionId: string | null = null) => {
  const stderr = boundedDiagnostic(result.stderr);
  const terminalRaw = result.terminalEvent ? boundedDiagnostic(result.terminalEvent.raw) : null;
  const terminalResult = result.terminalEvent ? boundedDiagnostic(safeJson(result.terminalEvent.parsed)) : null;
  return {
    externalSessionId: result.externalSessionId ?? priorExternalSessionId, adapterId,
    exitCode: result.exitCode, signal: result.signal, failureReason: result.failureReason,
    stderr: stderr.value, stderrTruncated: stderr.truncated,
    terminalEvent: result.terminalEvent ? { type: result.terminalEvent.type, externalSessionId: result.terminalEvent.externalSessionId, raw: terminalRaw!.value, rawTruncated: terminalRaw!.truncated, result: terminalResult!.value, resultTruncated: terminalResult!.truncated } : null,
  };
};
const correctionFailureEvidence = (attempt: number, resumed: boolean, priorExternalSessionId: string | null, adapterId: string, result: AgentExecutionResult) => ({ attempt, resumed, priorExternalSessionId, ...executionFailureEvidence(adapterId, result, priorExternalSessionId) });
const safeJson = (value: unknown): string => { try { return JSON.stringify(value) ?? 'null'; } catch { return '[Unserializable terminal result]'; } };
const followUpPrompt = (prompt: string, correctivePrompt: string | null): string => correctivePrompt ? `${prompt}\n\nFollow-up corrective instruction:\n${correctivePrompt}` : prompt;
const correctionPrompt = (originalPrompt: string, evidence: { command: string; exitCode: number | null; output: string; outputTruncated: boolean }): string => {
  const output = evidence.output.length > MAX_CORRECTION_EVIDENCE_CHARS ? `${evidence.output.slice(0, MAX_CORRECTION_EVIDENCE_CHARS)}\n[Output truncated by NightShift.]` : evidence.output;
  return `The implementation from the previous turn is still present in the current worktree.

Original task context:
${originalPrompt}

NightShift deterministic validation failed:

Command:
${evidence.command}

Exit code:
${evidence.exitCode ?? 'unknown'}

Output:
${output || '(no output captured)'}${evidence.outputTruncated ? '\n[Validation output was truncated.]' : ''}

Inspect and correct the existing implementation so this validation failure is resolved. Preserve correct unrelated work and remain within the original task scope. Do not commit or push. Run only targeted checks useful for the correction; NightShift will rerun deterministic validation.`;
};
const initialRecoveryPrompt = (originalPrompt: string, result: AgentExecutionResult): string => {
  const evidence = [result.stderr, result.terminalEvent?.raw ?? '', result.terminalEvent ? safeJson(result.terminalEvent.parsed) : ''].filter(Boolean).join('\n\n');
  const boundedEvidence = evidence.length > MAX_CORRECTION_EVIDENCE_CHARS ? `${evidence.slice(0, MAX_CORRECTION_EVIDENCE_CHARS)}\n[Evidence truncated by NightShift.]` : evidence;
  return `The previous implementation attempt exited unsuccessfully.

The existing implementation remains in the current worktree.

Original task:
${originalPrompt}

Previous execution failure:

Exit code:
${result.exitCode ?? 'unknown'}

Signal:
${result.signal ?? 'none'}

Reason:
${result.failureReason ?? 'No reason was provided.'}

Relevant terminal/stderr evidence:
${boundedEvidence || '(no evidence captured)'}

Inspect the existing implementation and finish or repair it so it is ready for NightShift deterministic validation.

Preserve correct existing work. Remain strictly within the original task scope. Do not reset or discard the worktree. Do not commit or push. Run only targeted checks useful while repairing the implementation. NightShift will perform final deterministic validation.`;
};
const providerRetryPrompt = (): string => 'The previous provider request was interrupted by a transient service failure. Continue the same task from the existing worktree. Preserve completed work, do not redo unrelated work, and do not commit or push.';
const gitFailure = (prefix: string, result: GitCommandResult): string => `${prefix} ${result.stderr.trim() || result.stdout.trim() || 'Git returned an error.'}`;
const normalizeConcurrency = (value: unknown): number => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 4 ? value : 2;
const normalizeTimeout = (value: unknown, fallback: number): number => typeof value === 'number' && [30, 60, 90, 120].includes(value / 60_000) ? value : fallback;
