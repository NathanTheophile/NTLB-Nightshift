import type { AgentAdapter, AgentExecutionResult } from './contracts/AgentAdapter';
import type { RunService as RunServiceContract } from './contracts/RunService';
import { runGit } from './GitWorktreeService';
import type { WorktreeService } from './contracts/WorktreeService';
import type { PlannerTaskRepository } from '../persistence/repositories/PlannerTaskRepository';
import type { RunRepository } from '../persistence/repositories/RunRepository';
import type { WorkspaceRepository } from '../persistence/repositories/WorkspaceRepository';
import type { Run, RunStatus } from '@shared/domain/entities';

const terminalStatuses = new Set<RunStatus>(['completed', 'failed', 'blocked', 'cancelled', 'timed_out']);

export interface PlannerRunDefaults { agentId: string; modelId: string; timeoutMs: number; }
export class RunService implements RunServiceContract {
  private readonly active = new Map<string, { adapter: AgentAdapter; handleId: string; timedOut: boolean }>();
  private scheduling = false;
  public constructor(private readonly runs: RunRepository, private readonly tasks: PlannerTaskRepository, private readonly workspaces: WorkspaceRepository, private readonly worktrees: WorktreeService, private readonly adapters: ReadonlyMap<string, AgentAdapter>, private readonly defaults: PlannerRunDefaults) {}
  public createAttempt(spec: { taskId: string; workspaceId: string; resolvedAgentId: string; resolvedModelId: string; baseSha: string }): Promise<Run> { void spec.baseSha; return Promise.resolve(this.runs.create(spec)); }
  public find(runId: string): Promise<Run | undefined> { return Promise.resolve(this.runs.find(runId)); }
  public list(workspaceId: string): Run[] { return this.runs.list(workspaceId); }
  public events(runId: string) { return this.runs.listEvents(runId); }
  public schedule(): void { if (!this.scheduling) void this.runQueue(); }
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
    const run = this.runs.create({ taskId: task.id, workspaceId: task.workspaceId, resolvedAgentId: agentId, resolvedModelId: modelId }); this.tasks.setStatus(task.id, 'running'); this.runs.appendEvent(run.id, 'preparing', { agentId, modelId });
    try {
      if (!workspace?.isGit) throw new Error('Write-capable Planner runs require a Git workspace.');
      const adapter = this.adapters.get(agentId); if (!adapter?.capabilities().plannerValidated) throw new Error(`Planner agent ${agentId} is not validated.`);
      const head = await runGit(workspace.rootPath, ['rev-parse', '--verify', 'HEAD']); if (head.exitCode !== 0) throw new Error('Could not determine Git HEAD for Planner run.');
      const worktree = await this.worktrees.createForRun({ runId: run.id, repositoryRoot: workspace.rootPath, baseSha: head.stdout.trim() });
      this.runs.setPreparation(run.id, worktree.baseSha, worktree.path); this.runs.appendEvent(run.id, 'worktree_created', worktree);
      this.runs.setStatus(run.id, 'running', { started_at: new Date().toISOString() }); this.runs.appendEvent(run.id, 'running', {});
      const handle = await adapter.startRun({ runId: run.id, workspaceId: workspace.id, workingDirectory: worktree.path, modelId, prompt: task.prompt, onProtocolEvent: (event) => this.runs.appendEvent(run.id, 'claude_protocol', event, event.timestamp) });
      this.active.set(run.id, { adapter, handleId: handle.handleId, timedOut: false });
      const result = await this.waitWithTimeout(run.id, handle.completion);
      const current = this.runs.findRequired(run.id); const finalGit = await inspectGit(worktree.path); const cancelled = current.status === 'cancel_requested';
      const status: RunStatus = current.status === 'timed_out' ? 'timed_out' : cancelled ? 'cancelled' : result.succeeded ? 'completed' : 'failed';
      this.runs.setStatus(run.id, status, { finished_at: new Date().toISOString(), exit_code: result.exitCode, result_summary: result.terminalEvent?.raw ?? null, failure_reason: status === 'completed' ? null : result.failureReason ?? (cancelled ? 'Cancelled by user.' : 'Run failed.'), validation_status: 'not_configured', external_session_id: result.externalSessionId, final_head_sha: finalGit.head, final_git_state: JSON.stringify(finalGit) });
      this.runs.appendEvent(run.id, 'terminal', { status, exitCode: result.exitCode, signal: result.signal }); this.tasks.setStatus(task.id, taskStatus(status));
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
  private async waitWithTimeout(runId: string, completion: Promise<AgentExecutionResult>): Promise<AgentExecutionResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([completion, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Run timed out.')), this.defaults.timeoutMs); })]); }
    catch (error) { if ((error as Error).message !== 'Run timed out.') throw error; this.runs.setStatus(runId, 'timed_out', { finished_at: new Date().toISOString(), failure_reason: 'Run exceeded the hard timeout.' }); this.runs.appendEvent(runId, 'timeout', {}); const active = this.active.get(runId); if (active) { active.timedOut = true; await active.adapter.cancel(active.handleId); await completion.catch(() => undefined); } throw error; }
    finally { if (timer) clearTimeout(timer); }
  }
}
const taskStatus = (status: RunStatus): 'completed' | 'failed' | 'blocked' | 'cancelled' => status === 'completed' ? 'completed' : status === 'cancelled' ? 'cancelled' : status === 'timed_out' ? 'failed' : status === 'failed' ? 'failed' : 'blocked';
const inspectGit = async (path: string): Promise<{ head: string | null; status: string; diffStat: string }> => { const [head, status, diffStat] = await Promise.all([runGit(path, ['rev-parse', 'HEAD']), runGit(path, ['status', '--porcelain=v1']), runGit(path, ['diff', '--stat'])]); return { head: head.exitCode === 0 ? head.stdout.trim() : null, status: status.stdout, diffStat: diffStat.stdout }; };
