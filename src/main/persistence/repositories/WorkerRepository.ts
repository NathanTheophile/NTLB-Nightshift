import { randomUUID } from 'node:crypto';

import type { WorkerConversation, WorkerEvent, WorkerStatus } from '@shared/domain/entities';

import type { DatabaseService } from '../DatabaseService';

interface WorkerRow {
  id: string; workspace_id: string; title: string; agent_id: string; model_id: string;
  permission_profile: WorkerConversation['permissionProfile']; isolation_mode: WorkerConversation['isolationMode'];
  external_session_id: string | null; working_directory: string; base_sha: string | null; status: WorkerStatus;
  created_at: string; updated_at: string;
}
interface WorkerEventRow { id: string; worker_id: string; sequence: number; timestamp: string; role_or_type: string; content: string | null; payload_json: string; }

export class WorkerRepository {
  public constructor(private readonly database: DatabaseService) {}

  public create(spec: Omit<WorkerConversation, 'externalSessionId' | 'status' | 'createdAt' | 'updatedAt'>): WorkerConversation {
    const id = spec.id || randomUUID(); const now = new Date().toISOString();
    this.database.execute(`INSERT INTO workers(id, workspace_id, title, agent_id, model_id, permission_profile, isolation_mode, working_directory, base_sha, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?)`, id, spec.workspaceId, spec.title, spec.agentId, spec.modelId, spec.permissionProfile, spec.isolationMode, spec.workingDirectory, spec.baseSha, now, now);
    return this.findRequired(id);
  }

  public find(id: string): WorkerConversation | undefined { const row = this.database.queryOne<WorkerRow>('SELECT * FROM workers WHERE id = ?', id); return row ? mapWorker(row) : undefined; }
  public findRequired(id: string): WorkerConversation { const worker = this.find(id); if (!worker) throw new Error(`Worker ${id} was not found.`); return worker; }
  public list(workspaceId: string): WorkerConversation[] { return this.database.queryAll<WorkerRow>('SELECT * FROM workers WHERE workspace_id = ? ORDER BY updated_at DESC', workspaceId).map(mapWorker); }
  public setState(id: string, status: WorkerStatus, externalSessionId?: string | null): WorkerConversation {
    const now = new Date().toISOString();
    if (externalSessionId === undefined) this.database.execute('UPDATE workers SET status = ?, updated_at = ? WHERE id = ?', status, now, id);
    else this.database.execute('UPDATE workers SET status = ?, external_session_id = ?, updated_at = ? WHERE id = ?', status, externalSessionId, now, id);
    return this.findRequired(id);
  }
  public appendEvent(workerId: string, roleOrType: string, content: string | null, payload: unknown, timestamp = new Date().toISOString()): WorkerEvent {
    const sequence = this.database.queryOne<{ sequence: number }>('SELECT COALESCE(MAX(sequence), -1) + 1 AS sequence FROM worker_events WHERE worker_id = ?', workerId)?.sequence ?? 0;
    const id = randomUUID(); this.database.execute('INSERT INTO worker_events(id, worker_id, sequence, timestamp, role_or_type, content, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)', id, workerId, sequence, timestamp, roleOrType, content, JSON.stringify(payload));
    return { id, workerId, sequence, timestamp, roleOrType, content, payload };
  }
  public listEvents(workerId: string): WorkerEvent[] { return this.database.queryAll<WorkerEventRow>('SELECT * FROM worker_events WHERE worker_id = ? ORDER BY sequence', workerId).map((row) => ({ id: row.id, workerId: row.worker_id, sequence: row.sequence, timestamp: row.timestamp, roleOrType: row.role_or_type, content: row.content, payload: JSON.parse(row.payload_json) as unknown })); }
}

const mapWorker = (row: WorkerRow): WorkerConversation => ({ id: row.id, workspaceId: row.workspace_id, title: row.title, agentId: row.agent_id, modelId: row.model_id, permissionProfile: row.permission_profile, isolationMode: row.isolation_mode, externalSessionId: row.external_session_id, workingDirectory: row.working_directory, baseSha: row.base_sha, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at });
