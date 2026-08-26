import type { CreatePlannerTaskInput } from '@shared/contracts/ipc';
import type { PlannerTask } from '@shared/domain/entities';

export interface PlannerService {
  listTasks(workspaceId: string): PlannerTask[];
  createTask(input: CreatePlannerTaskInput): PlannerTask;
  archiveTask(taskId: string): PlannerTask;
  deleteQueuedTask(taskId: string): void;
  updateQueuedPriority(taskId: string, priority: number): PlannerTask;
  purgeTask(taskId: string): Promise<void>;
}
