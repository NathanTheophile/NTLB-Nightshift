import type { CreatePlannerTaskInput } from '@shared/contracts/ipc';
import type { PlannerTask } from '@shared/domain/entities';
import type { RunStatus } from '@shared/domain/entities';

export interface PlannerService {
  listTasks(workspaceId: string): PlannerTask[];
  createTask(input: CreatePlannerTaskInput): PlannerTask;
  archiveTask(taskId: string): PlannerTask;
  deleteTask(taskId: string): Promise<void>;
}
