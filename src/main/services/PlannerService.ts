import type { CreatePlannerTaskInput } from '@shared/contracts/ipc';
import type { PlannerTask } from '@shared/domain/entities';

import type { PlannerTaskRepository } from '../persistence/repositories/PlannerTaskRepository';
import type { WorkspaceRepository } from '../persistence/repositories/WorkspaceRepository';
import type { PlannerService as PlannerServiceContract } from './contracts/PlannerService';

export class PlannerService implements PlannerServiceContract {
  public constructor(
    private readonly tasks: PlannerTaskRepository,
    private readonly workspaces: WorkspaceRepository,
  ) {}

  public listTasks(workspaceId: string): PlannerTask[] {
    this.assertWorkspace(workspaceId);
    return this.tasks.listVisible(workspaceId);
  }

  public createTask(input: CreatePlannerTaskInput): PlannerTask {
    this.assertWorkspace(input.workspaceId);
    const prompt = input.prompt.trim();
    if (!prompt) {
      throw new Error('A Planner task requires a prompt.');
    }
    if (!Number.isInteger(input.priority) || input.priority < 1 || input.priority > 99) {
      throw new Error('Planner priority must be an integer between 1 and 99.');
    }

    return this.tasks.create({ ...input, prompt });
  }

  public archiveTask(taskId: string): PlannerTask {
    if (!taskId) {
      throw new Error('A Planner task id is required.');
    }
    return this.tasks.archiveCompleted(taskId);
  }

  private assertWorkspace(workspaceId: string): void {
    if (!workspaceId || !this.workspaces.findById(workspaceId)) {
      throw new Error('A valid workspace is required.');
    }
  }
}
