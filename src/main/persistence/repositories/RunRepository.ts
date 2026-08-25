import { randomUUID } from 'node:crypto';

import type { BatchStep, BatchStepStatus, CandidatePublishState, PlannerExecutionMode, Run, RunEvent, RunStatus } from '@shared/domain/entities';

import type { DatabaseService } from '../DatabaseService';

interface RunRow {
  id: string; task_id: string; workspace_id: string; resolved_agent_id: string; resolved_model_id: string;
  status: RunStatus; execution_mode: PlannerExecutionMode; base_sha: string | null; worktree_path: string | null; started_at: string | null;
  finished_at: string | null; exit_code: number | null; result_summary: string | null; failure_reason: string | null;
  validation_status: string | null; external_session_id: string | null; final_head_sha: string | null;
  final_git_state: string | null; source_run_id: string | null; follow_up_prompt: string | null;
  candidate_branch_name: string | null; candidate_commit_sha: string | null; candidate_remote_name: string | null;
  candidate_publish_state: CandidatePublishState; candidate_published_at: string | null;
  candidate_failure_reason: string | null; created_at: string;
}
interface RunEventRow { id: string; run_id: string; sequence: number; timestamp: string; event_type: string; payload_json: string; }
interface BatchStepRow { id: string; run_id: string; step_index: number; prompt: string; status: BatchStepStatus; started_at: string | null; finished_at: string | null; external_session_id: string | null; result_summary: string | null; failure_reason: string | null; }

export class RunRepository {
  public constructor(private readonly database: DatabaseService) {}

  public create(spec: { taskId: string; workspaceId: string; resolvedAgentId: string; resolvedModelId: string; executionMode?: PlannerExecutionMode; sourceRunId?: string; followUpPrompt?: string }): Run {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database.execute(`INSERT INTO runs(id, task_id, workspace_id, resolved_agent_id, resolved_model_id, execution_mode, source_run_id, follow_up_prompt, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'preparing', ?)`, id, spec.taskId, spec.workspaceId, spec.resolvedAgentId, spec.resolvedModelId, spec.executionMode ?? 'single_agent', spec.sourceRunId ?? null, spec.followUpPrompt?.trim() || null, now);
    return this.findRequired(id);
  }
  public find(id: string): Run | undefined { const row = this.database.queryOne<RunRow>('SELECT * FROM runs WHERE id = ?', id); return row ? mapRun(row) : undefined; }
  public findRequired(id: string): Run { const run = this.find(id); if (!run) throw new Error(`Run ${id} was not found.`); return run; }
  public list(workspaceId: string): Run[] { return this.database.queryAll<RunRow>('SELECT * FROM runs WHERE workspace_id = ? ORDER BY created_at DESC', workspaceId).map(mapRun); }
  public setPreparation(id: string, baseSha: string, worktreePath: string): Run { this.update(id, { base_sha: baseSha, worktree_path: worktreePath }); return this.findRequired(id); }
  public setBaseSha(id: string, baseSha: string): Run { this.update(id, { base_sha: baseSha }); return this.findRequired(id); }
  public setCandidateCommit(id: string, branchName: string, commitSha: string): Run {
    this.update(id, { candidate_branch_name: branchName, candidate_commit_sha: commitSha });
    return this.findRequired(id);
  }
  public tryBeginCandidatePublish(id: string): boolean {
    return this.database.execute(`UPDATE runs SET candidate_publish_state = 'publishing', candidate_failure_reason = NULL
      WHERE id = ? AND status = 'completed' AND candidate_commit_sha IS NOT NULL
        AND candidate_publish_state IN ('not_published', 'failed')`, id).changes === 1;
  }
  public setCandidatePublished(id: string, remoteName: string): Run {
    this.update(id, { candidate_publish_state: 'published', candidate_remote_name: remoteName, candidate_published_at: new Date().toISOString(), candidate_failure_reason: null });
    return this.findRequired(id);
  }
  public setCandidatePublishFailure(id: string, reason: string): Run {
    this.update(id, { candidate_publish_state: 'failed', candidate_failure_reason: reason });
    return this.findRequired(id);
  }
  public setStatus(id: string, status: RunStatus, values: Partial<Pick<RunRow, 'started_at' | 'finished_at' | 'exit_code' | 'result_summary' | 'failure_reason' | 'validation_status' | 'external_session_id' | 'final_head_sha' | 'final_git_state'>> = {}): Run {
    this.update(id, { status, ...values }); return this.findRequired(id);
  }
  public appendEvent(runId: string, eventType: string, payload: unknown, timestamp = new Date().toISOString()): RunEvent {
    const next = this.database.queryOne<{ sequence: number }>('SELECT COALESCE(MAX(sequence), -1) + 1 AS sequence FROM run_events WHERE run_id = ?', runId)?.sequence ?? 0;
    const id = randomUUID(); this.database.execute('INSERT INTO run_events(id, run_id, sequence, timestamp, event_type, payload_json) VALUES (?, ?, ?, ?, ?, ?)', id, runId, next, timestamp, eventType, JSON.stringify(payload));
    return { id, runId, sequence: next, timestamp, eventType, payload };
  }
  public listEvents(runId: string): RunEvent[] { return this.database.queryAll<RunEventRow>('SELECT * FROM run_events WHERE run_id = ? ORDER BY sequence', runId).map((row) => ({ id: row.id, runId: row.run_id, sequence: row.sequence, timestamp: row.timestamp, eventType: row.event_type, payload: parsePayload(row.payload_json) })); }
  public createBatchSteps(runId: string, prompts: readonly string[]): BatchStep[] {
    prompts.forEach((prompt, stepIndex) => this.database.execute('INSERT INTO run_batch_steps(id, run_id, step_index, prompt, status) VALUES (?, ?, ?, ?, \'pending\')', randomUUID(), runId, stepIndex, prompt));
    return this.batchSteps(runId);
  }
  public batchSteps(runId: string): BatchStep[] { return this.database.queryAll<BatchStepRow>('SELECT * FROM run_batch_steps WHERE run_id = ? ORDER BY step_index', runId).map(mapBatchStep); }
  public setBatchStepStatus(id: string, status: BatchStepStatus, values: Partial<Pick<BatchStepRow, 'started_at' | 'finished_at' | 'external_session_id' | 'result_summary' | 'failure_reason'>> = {}): BatchStep {
    const entries = Object.entries({ status, ...values }).filter(([, value]) => value !== undefined);
    this.database.execute(`UPDATE run_batch_steps SET ${entries.map(([field]) => `${field} = ?`).join(', ')} WHERE id = ?`, ...entries.map(([, value]) => value), id);
    const row = this.database.queryOne<BatchStepRow>('SELECT * FROM run_batch_steps WHERE id = ?', id); if (!row) throw new Error(`Batch step ${id} was not found.`); return mapBatchStep(row);
  }
  private update(id: string, fields: Record<string, unknown>): void { const entries = Object.entries(fields).filter(([, value]) => value !== undefined); if (!entries.length) return; this.database.execute(`UPDATE runs SET ${entries.map(([field]) => `${field} = ?`).join(', ')} WHERE id = ?`, ...entries.map(([, value]) => value === undefined ? null : value as string | number | null), id); }
}

const mapRun = (row: RunRow): Run => ({ id: row.id, taskId: row.task_id, workspaceId: row.workspace_id, resolvedAgentId: row.resolved_agent_id, resolvedModelId: row.resolved_model_id, executionMode: row.execution_mode ?? 'single_agent', status: row.status, sourceRunId: row.source_run_id, followUpPrompt: row.follow_up_prompt, baseSha: row.base_sha, worktreePath: row.worktree_path, startedAt: row.started_at, finishedAt: row.finished_at, exitCode: row.exit_code, resultSummary: row.result_summary, failureReason: row.failure_reason, validationStatus: row.validation_status, externalSessionId: row.external_session_id, finalHeadSha: row.final_head_sha, finalGitState: row.final_git_state, candidateBranchName: row.candidate_branch_name, candidateCommitSha: row.candidate_commit_sha, candidateRemoteName: row.candidate_remote_name, candidatePublishState: row.candidate_publish_state ?? 'not_published', candidatePublishedAt: row.candidate_published_at, candidateFailureReason: row.candidate_failure_reason, createdAt: row.created_at });
const mapBatchStep = (row: BatchStepRow): BatchStep => ({ id: row.id, runId: row.run_id, stepIndex: row.step_index, prompt: row.prompt, status: row.status, startedAt: row.started_at, finishedAt: row.finished_at, externalSessionId: row.external_session_id, resultSummary: row.result_summary, failureReason: row.failure_reason });
const parsePayload = (value: string): unknown => JSON.parse(value) as unknown;
