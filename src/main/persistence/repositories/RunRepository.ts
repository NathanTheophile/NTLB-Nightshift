import { randomUUID } from 'node:crypto';

import type { Run, RunEvent, RunStatus } from '@shared/domain/entities';

import type { DatabaseService } from '../DatabaseService';

interface RunRow {
  id: string; task_id: string; workspace_id: string; resolved_agent_id: string; resolved_model_id: string;
  status: RunStatus; base_sha: string | null; worktree_path: string | null; started_at: string | null;
  finished_at: string | null; exit_code: number | null; result_summary: string | null; failure_reason: string | null;
  validation_status: string | null; external_session_id: string | null; final_head_sha: string | null;
  final_git_state: string | null; created_at: string;
}
interface RunEventRow { id: string; run_id: string; sequence: number; timestamp: string; event_type: string; payload_json: string; }

export class RunRepository {
  public constructor(private readonly database: DatabaseService) {}

  public create(spec: { taskId: string; workspaceId: string; resolvedAgentId: string; resolvedModelId: string }): Run {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database.execute(`INSERT INTO runs(id, task_id, workspace_id, resolved_agent_id, resolved_model_id, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'preparing', ?)`, id, spec.taskId, spec.workspaceId, spec.resolvedAgentId, spec.resolvedModelId, now);
    return this.findRequired(id);
  }
  public find(id: string): Run | undefined { const row = this.database.queryOne<RunRow>('SELECT * FROM runs WHERE id = ?', id); return row ? mapRun(row) : undefined; }
  public findRequired(id: string): Run { const run = this.find(id); if (!run) throw new Error(`Run ${id} was not found.`); return run; }
  public list(workspaceId: string): Run[] { return this.database.queryAll<RunRow>('SELECT * FROM runs WHERE workspace_id = ? ORDER BY created_at DESC', workspaceId).map(mapRun); }
  public setPreparation(id: string, baseSha: string, worktreePath: string): Run { this.update(id, { base_sha: baseSha, worktree_path: worktreePath }); return this.findRequired(id); }
  public setBaseSha(id: string, baseSha: string): Run { this.update(id, { base_sha: baseSha }); return this.findRequired(id); }
  public setStatus(id: string, status: RunStatus, values: Partial<Pick<RunRow, 'started_at' | 'finished_at' | 'exit_code' | 'result_summary' | 'failure_reason' | 'validation_status' | 'external_session_id' | 'final_head_sha' | 'final_git_state'>> = {}): Run {
    this.update(id, { status, ...values }); return this.findRequired(id);
  }
  public appendEvent(runId: string, eventType: string, payload: unknown, timestamp = new Date().toISOString()): RunEvent {
    const next = this.database.queryOne<{ sequence: number }>('SELECT COALESCE(MAX(sequence), -1) + 1 AS sequence FROM run_events WHERE run_id = ?', runId)?.sequence ?? 0;
    const id = randomUUID(); this.database.execute('INSERT INTO run_events(id, run_id, sequence, timestamp, event_type, payload_json) VALUES (?, ?, ?, ?, ?, ?)', id, runId, next, timestamp, eventType, JSON.stringify(payload));
    return { id, runId, sequence: next, timestamp, eventType, payload };
  }
  public listEvents(runId: string): RunEvent[] { return this.database.queryAll<RunEventRow>('SELECT * FROM run_events WHERE run_id = ? ORDER BY sequence', runId).map((row) => ({ id: row.id, runId: row.run_id, sequence: row.sequence, timestamp: row.timestamp, eventType: row.event_type, payload: parsePayload(row.payload_json) })); }
  private update(id: string, fields: Record<string, unknown>): void { const entries = Object.entries(fields).filter(([, value]) => value !== undefined); if (!entries.length) return; this.database.execute(`UPDATE runs SET ${entries.map(([field]) => `${field} = ?`).join(', ')} WHERE id = ?`, ...entries.map(([, value]) => value === undefined ? null : value as string | number | null), id); }
}

const mapRun = (row: RunRow): Run => ({ id: row.id, taskId: row.task_id, workspaceId: row.workspace_id, resolvedAgentId: row.resolved_agent_id, resolvedModelId: row.resolved_model_id, status: row.status, baseSha: row.base_sha, worktreePath: row.worktree_path, startedAt: row.started_at, finishedAt: row.finished_at, exitCode: row.exit_code, resultSummary: row.result_summary, failureReason: row.failure_reason, validationStatus: row.validation_status, externalSessionId: row.external_session_id, finalHeadSha: row.final_head_sha, finalGitState: row.final_git_state, createdAt: row.created_at });
const parsePayload = (value: string): unknown => JSON.parse(value) as unknown;
