import { randomUUID } from 'node:crypto';

import type { BatchStep, BatchStepStatus, CandidatePublishState, PlannerExecutionMode, Run, RunEvent, RunEventKind, RunEventPage, RunStatus, RunValidationCommand, ValidationCommandStatus, ValidationStatus } from '@shared/domain/entities';

import type { DatabaseService } from '../DatabaseService';

interface RunRow {
  id: string; task_id: string; workspace_id: string; resolved_agent_id: string; resolved_model_id: string;
  status: RunStatus; execution_mode: string; base_sha: string | null; worktree_path: string | null; started_at: string | null;
  finished_at: string | null; exit_code: number | null; result_summary: string | null; failure_reason: string | null;
  validation_status: ValidationStatus | null; external_session_id: string | null; final_head_sha: string | null;
  final_git_state: string | null; source_run_id: string | null; follow_up_prompt: string | null;
  candidate_branch_name: string | null; candidate_commit_sha: string | null; candidate_remote_name: string | null;
  candidate_publish_state: CandidatePublishState; candidate_published_at: string | null;
  candidate_failure_reason: string | null; created_at: string;
}
interface RunEventRow { id: string; run_id: string; sequence: number; timestamp: string; event_type: string; payload_json: string; }
interface BatchStepRow { id: string; run_id: string; step_index: number; prompt: string; status: BatchStepStatus; started_at: string | null; finished_at: string | null; external_session_id: string | null; result_summary: string | null; failure_reason: string | null; }
interface ValidationCommandRow { id: string; run_id: string; sequence: number; profile_id: string; command: string; status: ValidationCommandStatus; started_at: string; finished_at: string | null; exit_code: number | null; output: string; output_truncated: number; }

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
    const previous = eventType === 'agent_protocol' ? this.database.queryOne<RunEventRow>('SELECT * FROM run_events WHERE run_id = ? ORDER BY sequence DESC LIMIT 1', runId) : undefined;
    if (previous && canCompactProtocol(previous, payload)) {
      const previousPayload = parsePayload(previous.payload_json) as Record<string, unknown>;
      const fragments: unknown[] = Array.isArray(previousPayload.fragments) ? previousPayload.fragments as unknown[] : [protocolEvent(previousPayload)];
      const firstTimestamp = compactionTimestamp(previousPayload) ?? previous.timestamp;
      const compacted = { ...previousPayload, timestamp, fragments: [...fragments, protocolEvent(payload)], compaction: { sourceEventCount: fragments.length + 1, firstTimestamp, lastTimestamp: timestamp } };
      if (Buffer.byteLength(JSON.stringify(compacted), 'utf8') <= MAX_COMPACTED_PROTOCOL_BYTES) {
        this.database.execute('UPDATE run_events SET timestamp = ?, payload_json = ? WHERE id = ?', timestamp, JSON.stringify(compacted), previous.id);
        return { id: previous.id, runId, sequence: previous.sequence, timestamp, eventType, payload: compacted };
      }
    }
    const next = this.database.queryOne<{ sequence: number }>('SELECT COALESCE(MAX(sequence), -1) + 1 AS sequence FROM run_events WHERE run_id = ?', runId)?.sequence ?? 0;
    const id = randomUUID(); this.database.execute('INSERT INTO run_events(id, run_id, sequence, timestamp, event_type, payload_json) VALUES (?, ?, ?, ?, ?, ?)', id, runId, next, timestamp, eventType, JSON.stringify(payload));
    return { id, runId, sequence: next, timestamp, eventType, payload };
  }
  public listEvents(runId: string): RunEvent[] { return this.database.queryAll<RunEventRow>('SELECT * FROM run_events WHERE run_id = ? ORDER BY sequence', runId).map((row) => ({ id: row.id, runId: row.run_id, sequence: row.sequence, timestamp: row.timestamp, eventType: row.event_type, payload: parsePayload(row.payload_json) })); }
  public eventCount(runId: string, kind: RunEventKind): number {
    const predicate = kind === 'raw_protocol' ? 'event_type = \'agent_protocol\'' : 'event_type <> \'agent_protocol\'';
    return this.database.queryOne<{ total: number }>(`SELECT COUNT(*) AS total FROM run_events WHERE run_id = ? AND ${predicate}`, runId)?.total ?? 0;
  }
  public listEventPage(runId: string, kind: RunEventKind, cursor: number | null, limit: number): RunEventPage {
    const predicate = kind === 'raw_protocol' ? 'event_type = \'agent_protocol\'' : 'event_type <> \'agent_protocol\'';
    const total = this.eventCount(runId, kind);
    const rows = this.database.queryAll<RunEventRow>(`SELECT * FROM run_events WHERE run_id = ? AND ${predicate} AND sequence > ? ORDER BY sequence LIMIT ?`, runId, cursor ?? -1, limit + 1);
    const page = rows.slice(0, limit).map((row) => ({ id: row.id, runId: row.run_id, sequence: row.sequence, timestamp: row.timestamp, eventType: row.event_type, payload: parsePayload(row.payload_json) }));
    return { events: page, total, nextCursor: rows.length > limit ? page.at(-1)?.sequence ?? null : null };
  }
  public createBatchSteps(runId: string, prompts: readonly string[]): BatchStep[] {
    prompts.forEach((prompt, stepIndex) => this.database.execute('INSERT INTO run_batch_steps(id, run_id, step_index, prompt, status) VALUES (?, ?, ?, ?, \'pending\')', randomUUID(), runId, stepIndex, prompt));
    return this.batchSteps(runId);
  }
  public batchSteps(runId: string): BatchStep[] { return this.database.queryAll<BatchStepRow>('SELECT * FROM run_batch_steps WHERE run_id = ? ORDER BY step_index', runId).map(mapBatchStep); }
  public validationCommands(runId: string): RunValidationCommand[] { return this.database.queryAll<ValidationCommandRow>('SELECT * FROM run_validation_commands WHERE run_id = ? ORDER BY sequence', runId).map(mapValidationCommand); }
  public setValidationStatus(id: string, status: ValidationStatus): Run { this.update(id, { validation_status: status }); return this.findRequired(id); }
  public startValidationCommand(runId: string, profileId: string, command: string): RunValidationCommand {
    const sequence = this.database.queryOne<{ sequence: number }>('SELECT COALESCE(MAX(sequence), -1) + 1 AS sequence FROM run_validation_commands WHERE run_id = ?', runId)?.sequence ?? 0; const id = randomUUID(); const startedAt = new Date().toISOString();
    this.database.execute("INSERT INTO run_validation_commands(id, run_id, sequence, profile_id, command, status, started_at) VALUES (?, ?, ?, ?, ?, 'running', ?)", id, runId, sequence, profileId, command, startedAt); return this.validationCommands(runId).at(-1)!;
  }
  public finishValidationCommand(id: string, status: Exclude<ValidationCommandStatus, 'running'>, exitCode: number | null, output: string, outputTruncated: boolean): RunValidationCommand {
    this.database.execute('UPDATE run_validation_commands SET status = ?, finished_at = ?, exit_code = ?, output = ?, output_truncated = ? WHERE id = ?', status, new Date().toISOString(), exitCode, output, outputTruncated ? 1 : 0, id); const row = this.database.queryOne<ValidationCommandRow>('SELECT * FROM run_validation_commands WHERE id = ?', id); if (!row) throw new Error(`Validation command ${id} was not found.`); return mapValidationCommand(row);
  }
  public interruptRunningValidation(runId: string): void { this.database.execute("UPDATE run_validation_commands SET status = 'interrupted', finished_at = ?, output = CASE WHEN output = '' THEN ? ELSE output END WHERE run_id = ? AND status = 'running'", new Date().toISOString(), 'Validation interrupted by NightShift restart.', runId); }
  public staleRuns(): Run[] { return this.database.queryAll<RunRow>("SELECT * FROM runs WHERE status IN ('preparing', 'running', 'cancel_requested') ORDER BY created_at").map(mapRun); }
  public runningValidations(): Run[] { return this.database.queryAll<RunRow>("SELECT * FROM runs WHERE validation_status = 'running' ORDER BY created_at").map(mapRun); }
  public publishingCandidates(): Run[] { return this.database.queryAll<RunRow>("SELECT * FROM runs WHERE candidate_publish_state = 'publishing'").map(mapRun); }
  public setBatchStepStatus(id: string, status: BatchStepStatus, values: Partial<Pick<BatchStepRow, 'started_at' | 'finished_at' | 'external_session_id' | 'result_summary' | 'failure_reason'>> = {}): BatchStep {
    const entries = Object.entries({ status, ...values }).filter(([, value]) => value !== undefined);
    this.database.execute(`UPDATE run_batch_steps SET ${entries.map(([field]) => `${field} = ?`).join(', ')} WHERE id = ?`, ...entries.map(([, value]) => value), id);
    const row = this.database.queryOne<BatchStepRow>('SELECT * FROM run_batch_steps WHERE id = ?', id); if (!row) throw new Error(`Batch step ${id} was not found.`); return mapBatchStep(row);
  }
  private update(id: string, fields: Record<string, unknown>): void { const entries = Object.entries(fields).filter(([, value]) => value !== undefined); if (!entries.length) return; this.database.execute(`UPDATE runs SET ${entries.map(([field]) => `${field} = ?`).join(', ')} WHERE id = ?`, ...entries.map(([, value]) => value === undefined ? null : value as string | number | null), id); }
}

const mapRun = (row: RunRow): Run => ({ id: row.id, taskId: row.task_id, workspaceId: row.workspace_id, resolvedAgentId: row.resolved_agent_id, resolvedModelId: row.resolved_model_id, executionMode: row.execution_mode === 'sequential_batch' ? 'sequential_batch' : 'single_agent', status: row.status, sourceRunId: row.source_run_id, followUpPrompt: row.follow_up_prompt, baseSha: row.base_sha, worktreePath: row.worktree_path, startedAt: row.started_at, finishedAt: row.finished_at, exitCode: row.exit_code, resultSummary: row.result_summary, failureReason: row.failure_reason, validationStatus: row.validation_status, externalSessionId: row.external_session_id, finalHeadSha: row.final_head_sha, finalGitState: row.final_git_state, candidateBranchName: row.candidate_branch_name, candidateCommitSha: row.candidate_commit_sha, candidateRemoteName: row.candidate_remote_name, candidatePublishState: row.candidate_publish_state ?? 'not_published', candidatePublishedAt: row.candidate_published_at, candidateFailureReason: row.candidate_failure_reason, createdAt: row.created_at });
const mapBatchStep = (row: BatchStepRow): BatchStep => ({ id: row.id, runId: row.run_id, stepIndex: row.step_index, prompt: row.prompt, status: row.status, startedAt: row.started_at, finishedAt: row.finished_at, externalSessionId: row.external_session_id, resultSummary: row.result_summary, failureReason: row.failure_reason });
const mapValidationCommand = (row: ValidationCommandRow): RunValidationCommand => ({ id: row.id, runId: row.run_id, sequence: row.sequence, profileId: row.profile_id, command: row.command, status: row.status, startedAt: row.started_at, finishedAt: row.finished_at, exitCode: row.exit_code, output: row.output, outputTruncated: row.output_truncated === 1 });
const parsePayload = (value: string): unknown => JSON.parse(value) as unknown;
const MAX_COMPACTED_PROTOCOL_BYTES = 64 * 1024;

const protocolEvent = (payload: unknown): unknown => {
  const value = payload as Record<string, unknown>;
  return value && typeof value === 'object' && 'event' in value ? value.event : payload;
};

const canCompactProtocol = (previous: RunEventRow, nextPayload: unknown): boolean => {
  const currentPayload = parsePayload(previous.payload_json);
  const current = protocolEvent(currentPayload) as Record<string, unknown>;
  const next = protocolEvent(nextPayload) as Record<string, unknown>;
  if (!current || !next || typeof current !== 'object' || typeof next !== 'object') return false;
  if (current.terminal !== false || next.terminal !== false || current.parseError !== null || next.parseError !== null) return false;
  if (!isNoisyProtocolType(current.type) || current.type !== next.type || current.externalSessionId !== next.externalSessionId) return false;
  return batchStep(currentPayload) === batchStep(nextPayload);
};

const batchStep = (payload: unknown): number | undefined => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const value = (payload as Record<string, unknown>).stepIndex;
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
};

const isNoisyProtocolType = (value: unknown): value is string => typeof value === 'string' && /(?:^|[._-])(thinking|reasoning|token|delta)(?:$|[._-])/iu.test(value);
const compactionTimestamp = (payload: Record<string, unknown>): string | undefined => {
  const compaction = payload.compaction;
  return compaction && typeof compaction === 'object' && typeof (compaction as Record<string, unknown>).firstTimestamp === 'string'
    ? (compaction as { firstTimestamp: string }).firstTimestamp
    : undefined;
};
