import type { AgentAdapter, AgentExecutionResult } from './contracts/AgentAdapter';
import type { RunService as RunServiceContract } from './contracts/RunService';
import { runGit, type GitCommandResult } from './GitWorktreeService';
import type { WorktreeService } from './contracts/WorktreeService';
import type { PlannerTaskRepository } from '../persistence/repositories/PlannerTaskRepository';
import type { RunRepository } from '../persistence/repositories/RunRepository';
import type { WorkspaceRepository } from '../persistence/repositories/WorkspaceRepository';
import type { BatchStep, Run, RunStatus } from '@shared/domain/entities';
import { resolve } from 'node:path';

const terminalStatuses = new Set<RunStatus>(['completed', 'failed', 'blocked', 'cancelled', 'timed_out']);

export interface PlannerRunDefaults { agentId: string; modelId: string; timeoutMs: number; }
export class RunService implements RunServiceContract {
  private readonly active = new Map<string, { adapter: AgentAdapter; handleId: string; timedOut: boolean }>();
  private readonly publishing = new Map<string, Promise<Run>>();
  private readonly followUpQueue: string[] = [];
  private scheduling = false;
  public constructor(private readonly runs: RunRepository, private readonly tasks: PlannerTaskRepository, private readonly workspaces: WorkspaceRepository, private readonly worktrees: WorktreeService, private readonly adapters: ReadonlyMap<string, AgentAdapter>, private readonly defaults: PlannerRunDefaults) {}
  public createAttempt(spec: { taskId: string; workspaceId: string; resolvedAgentId: string; resolvedModelId: string; baseSha: string }): Promise<Run> {
    const run = this.runs.create(spec);
    return Promise.resolve(this.runs.setBaseSha(run.id, spec.baseSha));
  }
  public find(runId: string): Promise<Run | undefined> { return Promise.resolve(this.runs.find(runId)); }
  public list(workspaceId: string): Run[] { return this.runs.list(workspaceId); }
  public events(runId: string) { return this.runs.listEvents(runId); }
  public batchSteps(runId: string) { return this.runs.batchSteps(runId); }
  public schedule(): void { if (!this.scheduling) void this.runQueue().catch((error: unknown) => console.error('[Planner] Scheduler stopped unexpectedly.', error)); }
  public async requestCancellation(runId: string): Promise<Run> {
    const run = this.runs.findRequired(runId); if (terminalStatuses.has(run.status)) return run;
    this.runs.setStatus(runId, 'cancel_requested'); this.runs.appendEvent(runId, 'cancellation_requested', {});
    const active = this.active.get(runId); if (active) await active.adapter.cancel(active.handleId);
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
    const run = this.runs.create({ taskId: source.taskId, workspaceId: source.workspaceId, resolvedAgentId: source.resolvedAgentId, resolvedModelId: source.resolvedModelId, executionMode: source.executionMode, sourceRunId: source.id, followUpPrompt: correctivePrompt });
    this.runs.appendEvent(run.id, 'follow_up_created', { sourceRunId: source.id, baseSha: source.candidateCommitSha });
    this.followUpQueue.push(run.id); this.schedule();
    return Promise.resolve(run);
  }
  private async runQueue(): Promise<void> {
    this.scheduling = true;
    try { for (;;) { const followUpRunId = this.followUpQueue.shift(); if (followUpRunId) { await this.execute(this.runs.findRequired(followUpRunId).taskId, followUpRunId); continue; } const task = this.tasks.nextQueued(); if (!task) return; await this.execute(task.id); } } finally { this.scheduling = false; if (this.followUpQueue.length || this.tasks.nextQueued()) this.schedule(); }
  }
  private async execute(taskId: string, existingRunId?: string): Promise<void> {
    const task = this.tasks.findById(taskId); if (!task || (!existingRunId && task.status !== 'queued')) return;
    const workspace = this.workspaces.findById(task.workspaceId); const agentId = task.requestedAgentId ?? this.defaults.agentId; const modelId = task.requestedModelId ?? this.defaults.modelId;
    const run = existingRunId ? this.runs.findRequired(existingRunId) : this.runs.create({ taskId: task.id, workspaceId: task.workspaceId, resolvedAgentId: agentId, resolvedModelId: modelId, executionMode: task.executionMode });
    const batchSteps = task.executionMode === 'sequential_batch' ? this.runs.createBatchSteps(run.id, this.tasks.batchSteps(task.id)) : [];
    this.tasks.setStatus(task.id, 'running'); this.runs.appendEvent(run.id, 'preparing', { agentId, modelId, executionMode: task.executionMode });
    try {
      if (task.executionMode === 'delegated_leader') throw new Error('Delegated Leader execution is not supported.');
      if (!workspace?.isGit) throw new Error('Write-capable Planner runs require a Git workspace.');
      const adapter = this.adapters.get(agentId); if (!adapter?.capabilities().plannerValidated) throw new Error(`Planner agent ${agentId} is not validated.`);
      if (adapter.supportsPlannerModel && !adapter.supportsPlannerModel(modelId)) throw new Error(`Planner model ${modelId} is not validated for ${agentId}.`);
      const head = run.sourceRunId
        ? this.followUpBase(run.sourceRunId)
        : await runGit(workspace.rootPath, ['rev-parse', '--verify', 'HEAD']);
      if (head.exitCode !== 0) throw new Error('Could not determine Git base for Planner run.');
      if (await this.finalizeIfCancellationRequested(run.id, task.id, batchSteps)) return;
      const worktree = await this.worktrees.createForRun({ runId: run.id, repositoryRoot: workspace.rootPath, baseSha: head.stdout.trim() });
      this.runs.setPreparation(run.id, worktree.baseSha, worktree.path); this.runs.appendEvent(run.id, 'worktree_created', worktree);
      if (await this.finalizeIfCancellationRequested(run.id, task.id, batchSteps)) return;
      this.runs.setStatus(run.id, 'running', { started_at: new Date().toISOString() }); this.runs.appendEvent(run.id, 'running', {});
      const result = task.executionMode === 'sequential_batch'
        ? await this.executeBatch(run.id, workspace.id, worktree.path, modelId, adapter, followUpPrompt(task.prompt, run.followUpPrompt), batchSteps, Date.now() + this.defaults.timeoutMs)
        : await this.executeSingle(run.id, workspace.id, worktree.path, modelId, adapter, followUpPrompt(task.prompt, run.followUpPrompt));
      const current = this.runs.findRequired(run.id); const finalGit = await inspectGit(worktree.path); const cancelled = current.status === 'cancel_requested';
      const status: RunStatus = current.status === 'timed_out' ? 'timed_out' : cancelled ? 'cancelled' : result.succeeded ? 'completed' : 'failed';
      this.tasks.setStatus(task.id, taskStatus(status));
      this.runs.setStatus(run.id, status, { finished_at: new Date().toISOString(), exit_code: result.exitCode, result_summary: result.terminalEvent?.raw ?? null, failure_reason: status === 'completed' ? null : result.failureReason ?? (cancelled ? 'Cancelled by user.' : 'Run failed.'), validation_status: 'not_configured', external_session_id: result.externalSessionId, final_head_sha: finalGit.head, final_git_state: JSON.stringify(finalGit) });
      this.runs.appendEvent(run.id, 'terminal', { status, exitCode: result.exitCode, signal: result.signal });
      if (task.executionMode === 'sequential_batch') this.runs.appendEvent(run.id, batchTerminalEvent(status), { status });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error); const current = this.runs.findRequired(run.id);
      if (current.status === 'timed_out' && current.worktreePath) {
        const finalGit = await inspectGit(current.worktreePath);
        this.runs.setStatus(run.id, 'timed_out', { final_head_sha: finalGit.head, final_git_state: JSON.stringify(finalGit) });
      }
      if (!terminalStatuses.has(current.status)) { this.runs.setStatus(run.id, 'blocked', { finished_at: new Date().toISOString(), failure_reason: detail }); this.runs.appendEvent(run.id, 'blocked', { detail }); }
      if (task.executionMode === 'sequential_batch') this.runs.appendEvent(run.id, batchTerminalEvent(this.runs.findRequired(run.id).status), { status: this.runs.findRequired(run.id).status, detail });
      this.tasks.setStatus(task.id, taskStatus(this.runs.findRequired(run.id).status));
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
        const changes = await runGit(worktreePath, ['status', '--porcelain=v1']);
        if (changes.exitCode !== 0) throw new Error('Could not inspect candidate changes.');
        if (!changes.stdout.trim()) throw new Error('Cannot publish a candidate for a Run with no changes.');
        const branch = await runGit(worktreePath, ['rev-parse', '--verify', `refs/heads/${branchName}`]);
        if (branch.exitCode === 0) throw new Error(`Candidate branch ${branchName} already exists and is not owned by this Run.`);
        const created = await runGit(worktreePath, ['switch', '-c', branchName]);
        if (created.exitCode !== 0) throw new Error(gitFailure('Could not create candidate branch.', created));
        const staged = await runGit(worktreePath, ['add', '-A']); if (staged.exitCode !== 0) throw new Error(gitFailure('Could not stage candidate changes.', staged));
        const committed = await runGit(worktreePath, ['commit', '-m', `NightShift candidate: ${run.id}`]); if (committed.exitCode !== 0) throw new Error(gitFailure('Could not create candidate commit.', committed));
        const sha = await runGit(worktreePath, ['rev-parse', '--verify', 'HEAD']); if (sha.exitCode !== 0) throw new Error('Could not determine candidate commit SHA.');
        run = this.runs.setCandidateCommit(run.id, branchName, sha.stdout.trim()); this.runs.appendEvent(run.id, 'candidate_committed', { branchName, commitSha: run.candidateCommitSha });
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
      if (run?.candidateCommitSha) this.runs.setCandidatePublishFailure(runId, detail);
      throw error;
    }
  }
  private async executeSingle(runId: string, workspaceId: string, workingDirectory: string, modelId: string, adapter: AgentAdapter, prompt: string): Promise<AgentExecutionResult> {
    const handle = await adapter.startRun({ runId, workspaceId, workingDirectory, modelId, prompt, onProtocolEvent: (event) => this.runs.appendEvent(runId, 'agent_protocol', event, event.timestamp) });
    this.active.set(runId, { adapter, handleId: handle.handleId, timedOut: false });
    if (this.runs.findRequired(runId).status === 'cancel_requested') await adapter.cancel(handle.handleId);
    return this.waitWithTimeout(runId, handle.completion);
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
        this.active.set(runId, { adapter, handleId: handle.handleId, timedOut: false });
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
    this.tasks.setStatus(taskId, 'cancelled');
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
    const active = this.active.get(runId); if (active) { active.timedOut = true; await active.adapter.cancel(active.handleId); await completion.catch(() => undefined); }
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
