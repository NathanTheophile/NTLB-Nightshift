import { randomUUID } from 'node:crypto';

import type { CreatePlannerTaskInput } from '@shared/contracts/ipc';
import type { PlannerTask, PlannerTaskStatus } from '@shared/domain/entities';

import type { DatabaseService } from '../DatabaseService';

interface PlannerTaskRow {
  id: string;
  workspace_id: string;
  title: string;
  prompt: string;
  requested_agent_id: string | null;
  requested_model_id: string | null;
  priority: number;
  status: PlannerTaskStatus;
  visible_in_planner: number;
  created_at: string;
  updated_at: string;
}

export class PlannerTaskRepository {
  public constructor(private readonly database: DatabaseService) {}

  public listVisible(workspaceId: string): PlannerTask[] {
    return this.database
      .queryAll<PlannerTaskRow>(
        `SELECT * FROM tasks
         WHERE workspace_id = ? AND visible_in_planner = 1
         ORDER BY priority ASC, created_at ASC`,
        workspaceId,
      )
      .map(mapPlannerTask);
  }

  public create(input: CreatePlannerTaskInput): PlannerTask {
    const id = randomUUID();
    const now = new Date().toISOString();
    const normalizedPrompt = input.prompt.trim();
    const title = normalizedPrompt.split(/\r?\n/, 1)[0]?.slice(0, 96) ?? normalizedPrompt.slice(0, 96);

    this.database.execute(
      `INSERT INTO tasks(
        id, workspace_id, title, prompt, requested_agent_id, requested_model_id,
        priority, status, visible_in_planner, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 1, ?, ?)`,
      id,
      input.workspaceId,
      title,
      normalizedPrompt,
      input.requestedAgentId,
      input.requestedModelId,
      input.priority,
      now,
      now,
    );

    return this.findRequired(id);
  }

  public archiveCompleted(taskId: string): PlannerTask {
    const task = this.findRequired(taskId);
    if (task.status !== 'completed') {
      throw new Error('Only completed Planner tasks can be archived.');
    }

    this.database.execute(
      'UPDATE tasks SET visible_in_planner = 0, updated_at = ? WHERE id = ?',
      new Date().toISOString(),
      taskId,
    );
    return this.findRequired(taskId);
  }

  private findRequired(id: string): PlannerTask {
    const row = this.database.queryOne<PlannerTaskRow>('SELECT * FROM tasks WHERE id = ?', id);
    if (!row) {
      throw new Error(`Planner task ${id} was not found.`);
    }
    return mapPlannerTask(row);
  }
}

const mapPlannerTask = (row: PlannerTaskRow): PlannerTask => ({
  id: row.id,
  workspaceId: row.workspace_id,
  title: row.title,
  prompt: row.prompt,
  requestedAgentId: row.requested_agent_id,
  requestedModelId: row.requested_model_id,
  priority: row.priority,
  status: row.status,
  visibleInPlanner: row.visible_in_planner === 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});
