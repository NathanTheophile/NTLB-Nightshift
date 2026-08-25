import type { AgentAdapter, AgentExecutionResult } from './contracts/AgentAdapter';
import type { RunService as RunServiceContract } from './contracts/RunService';
import { runGit } from './GitWorktreeService';
import type { WorktreeService } from './contracts/WorktreeService';
import type { PlannerTaskRepository } from '../persistence/repositories/PlannerTaskRepository';
import type { RunRepository } from '../persistence/repositories/RunRepository';
import type { WorkspaceRepository } from '../persistence/repositories/WorkspaceRepository';
import type { BatchStep, Run, RunStatus } from '@shared/domain/entities';

const terminalStatuses = new Set<RunStatus>(['completed', 'failed', 'blocked', 'cancelled', 'timed_out']);

export interface PlannerRunDefaults { agentId: string; modelId: string; timeoutMs: number; }
export class RunService implements RunServiceContract {
  private readonly active = new Map<string, { adapter: AgentAdapter; handleId: string; timedOut: boolean }>();
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
  private async runQueue(): Promise<void> {
    this.scheduling = true;
    try { for (;;) { const task = this.tasks.nextQueued(); if (!task) return; await this.execute(task.id); } } finally { this.scheduling = false; if (this.tasks.nextQueued()) this.schedule(); }
  }
  private async execute(taskId: string): Promise<void> {
    const task = this.tasks.findById(taskId); if (!task || task.status !== 'queued') return;
    const workspace = this.workspaces.findById(task.workspaceId); const agentId = task.requestedAgentId ?? this.defaults.agentId; const modelId = task.requestedModelId ?? this.defaults.modelId;
    const run = this.runs.create({ taskId: task.id, workspaceId: task.workspaceId, resolvedAgentId: agentId, resolvedModelId: modelId, executionMode: task.executionMode }); this.tasks.setStatus(task.id, 'running'); this.runs.appendEvent(run.id, 'preparing', { agentId, modelId, executionMode: task.executionMode });
    try {
      if (task.executionMode === 'delegated_leader') throw new Error('Delegated Leader execution is not supported.');
      if (!workspace?.isGit) throw new Error('Write-capable Planner runs require a Git workspace.');
      const adapter = this.adapters.get(agentId); if (!adapter?.capabilities().plannerValidated) throw new Error(`Planner agent ${agentId} is not validated.`);
      if (adapter.supportsPlannerModel && !adapter.supportsPlannerModel(modelId)) throw new Error(`Planner model ${modelId} is not validated for ${agentId}.`);
      const head = await runGit(workspace.rootPath, ['rev-parse', '--verify', 'HEAD']); if (head.exitCode !== 0) throw new Error('Could not determine Git HEAD for Planner run.');
      if (await this.finalizeIfCancellationRequested(run.id, task.id)) return;
      const worktree = await this.worktrees.createForRun({ runId: run.id, repositoryRoot: workspace.rootPath, baseSha: head.stdout.trim() });
      this.runs.setPreparation(run.id, worktree.baseSha, worktree.path); this.runs.appendEvent(run.id, 'worktree_created', worktree);
      if (await this.finalizeIfCancellationRequested(run.id, task.id)) return;
      this.runs.setStatus(run.id, 'running', { started_at: new Date().toISOString() }); this.runs.appendEvent(run.id, 'running', {});
      const result = task.executionMode === 'sequential_batch'
        ? await this.executeBatch(run.id, task.id, workspace.id, worktree.path, modelId, adapter, task.prompt)
        : await this.executeSingle(run.id, workspace.id, worktree.path, modelId, adapter, task.prompt);
      const current = this.runs.findRequired(run.id); const finalGit = await inspectGit(worktree.path); const cancelled = current.status === 'cancel_requested';
      const status: RunStatus = current.status === 'timed_out' ? 'timed_out' : cancelled ? 'cancelled' : result.succeeded ? 'completed' : 'failed';
      this.tasks.setStatus(task.id, taskStatus(status));
      this.runs.setStatus(run.id, status, { finished_at: new Date().toISOString(), exit_code: result.exitCode, result_summary: result.terminalEvent?.raw ?? null, failure_reason: status === 'completed' ? null : result.failureReason ?? (cancelled ? 'Cancelled by user.' : 'Run failed.'), validation_status: 'not_configured', external_session_id: result.externalSessionId, final_head_sha: finalGit.head, final_git_state: JSON.stringify(finalGit) });
      this.runs.appendEvent(run.id, 'terminal', { status, exitCode: result.exitCode, signal: result.signal });
      if (task.executionMode === 'sequential_batch') this.runs.appendEvent(run.id, status === 'completed' ? 'batch_completed' : status === 'cancelled' ? 'batch_cancelled' : 'batch_failed', { status });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error); const current = this.runs.findRequired(run.id);
      if (current.status === 'timed_out' && current.worktreePath) {
        const finalGit = await inspectGit(current.worktreePath);
        this.runs.setStatus(run.id, 'timed_out', { final_head_sha: finalGit.head, final_git_state: JSON.stringify(finalGit) });
      }
      if (!terminalStatuses.has(current.status)) { this.runs.setStatus(run.id, 'blocked', { finished_at: new Date().toISOString(), failure_reason: detail }); this.runs.appendEvent(run.id, 'blocked', { detail }); }
      this.tasks.setStatus(task.id, taskStatus(this.runs.findRequired(run.id).status));
    } finally { this.active.delete(run.id); }
  }
  private async executeSingle(runId: string, workspaceId: string, workingDirectory: string, modelId: string, adapter: AgentAdapter, prompt: string): Promise<AgentExecutionResult> {
    const handle = await adapter.startRun({ runId, workspaceId, workingDirectory, modelId, prompt, onProtocolEvent: (event) => this.runs.appendEvent(runId, 'agent_protocol', event, event.timestamp) });
    this.active.set(runId, { adapter, handleId: handle.handleId, timedOut: false });
    if (this.runs.findRequired(runId).status === 'cancel_requested') await adapter.cancel(handle.handleId);
    return this.waitWithTimeout(runId, handle.completion);
  }
  private async executeBatch(runId: string, taskId: string, workspaceId: string, workingDirectory: string, modelId: string, adapter: AgentAdapter, sharedPrompt: string): Promise<AgentExecutionResult> {
    const steps = this.runs.createBatchSteps(runId, this.tasks.batchSteps(taskId));
    this.runs.appendEvent(runId, 'batch_started', { stepCount: steps.length });
    let lastResult: AgentExecutionResult | undefined;
    for (const step of steps) {
      if (this.runs.findRequired(runId).status === 'cancel_requested') {
        this.cancelPendingSteps(steps, step.stepIndex);
        return cancelledResult(lastResult);
      }
      this.runs.setBatchStepStatus(step.id, 'running', { started_at: new Date().toISOString() });
      this.runs.appendEvent(runId, 'batch_step_started', { stepIndex: step.stepIndex, prompt: step.prompt });
      try {
        const prompt = sharedPrompt ? `Shared batch context:\n${sharedPrompt}\n\nCurrent ordered step:\n${step.prompt}` : step.prompt;
        const handle = await adapter.startRun({ runId, workspaceId, workingDirectory, modelId, prompt, onProtocolEvent: (event) => this.runs.appendEvent(runId, 'agent_protocol', { stepIndex: step.stepIndex, event }, event.timestamp) });
        this.active.set(runId, { adapter, handleId: handle.handleId, timedOut: false });
        if (this.runs.findRequired(runId).status === 'cancel_requested') await adapter.cancel(handle.handleId);
        const result = await this.waitWithTimeout(runId, handle.completion);
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
        this.runs.appendEvent(runId, timedOut ? 'batch_step_failed' : 'batch_step_failed', { stepIndex: step.stepIndex, detail, timedOut });
        this.cancelPendingSteps(steps, step.stepIndex + 1); throw error;
      } finally { this.active.delete(runId); }
    }
    return lastResult ?? cancelledResult(undefined);
  }
  private cancelPendingSteps(steps: readonly BatchStep[], fromIndex: number): void {
    steps.filter((step) => step.stepIndex >= fromIndex).forEach((step) => this.runs.setBatchStepStatus(step.id, 'cancelled', { finished_at: new Date().toISOString(), failure_reason: 'Not started because the batch did not complete.' }));
  }
  private async finalizeIfCancellationRequested(runId: string, taskId: string): Promise<boolean> {
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
    this.tasks.setStatus(taskId, 'cancelled');
    return true;
  }
  private async waitWithTimeout(runId: string, completion: Promise<AgentExecutionResult>): Promise<AgentExecutionResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([completion, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Run timed out.')), this.defaults.timeoutMs); })]); }
    catch (error) { if ((error as Error).message !== 'Run timed out.') throw error; this.runs.setStatus(runId, 'timed_out', { finished_at: new Date().toISOString(), failure_reason: 'Run exceeded the hard timeout.' }); this.runs.appendEvent(runId, 'timeout', {}); const active = this.active.get(runId); if (active) { active.timedOut = true; await active.adapter.cancel(active.handleId); await completion.catch(() => undefined); } throw error; }
    finally { if (timer) clearTimeout(timer); }
  }
}
const taskStatus = (status: RunStatus): 'completed' | 'failed' | 'blocked' | 'cancelled' => status === 'completed' ? 'completed' : status === 'cancelled' ? 'cancelled' : status === 'timed_out' ? 'failed' : status === 'failed' ? 'failed' : 'blocked';
const cancelledResult = (previous: AgentExecutionResult | undefined): AgentExecutionResult => previous ?? { handleId: 'cancelled-before-step', succeeded: false, failureReason: 'Cancelled by user.', exitCode: null, signal: null, externalSessionId: null, events: [], terminalEvent: null, stderr: '' };
const inspectGit = async (path: string): Promise<{ head: string | null; status: string; diffStat: string }> => { const [head, status, diffStat] = await Promise.all([runGit(path, ['rev-parse', 'HEAD']), runGit(path, ['status', '--porcelain=v1']), runGit(path, ['diff', '--stat'])]); return { head: head.exitCode === 0 ? head.stdout.trim() : null, status: status.stdout, diffStat: diffStat.stdout }; };
