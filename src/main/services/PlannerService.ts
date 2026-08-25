import type { CreatePlannerTaskInput } from '@shared/contracts/ipc';
import type { PlannerTask } from '@shared/domain/entities';

import type { PlannerTaskRepository } from '../persistence/repositories/PlannerTaskRepository';
import type { WorkspaceRepository } from '../persistence/repositories/WorkspaceRepository';
import type { PlannerService as PlannerServiceContract } from './contracts/PlannerService';
import type { RunService } from './contracts/RunService';

export class PlannerService implements PlannerServiceContract {
  public constructor(
    private readonly tasks: PlannerTaskRepository,
    private readonly workspaces: WorkspaceRepository,
    private readonly runs?: RunService,
  ) {}

  public listTasks(workspaceId: string): PlannerTask[] {
    this.assertWorkspace(workspaceId);
    return this.tasks.listVisible(workspaceId);
  }

  public createTask(input: CreatePlannerTaskInput): PlannerTask {
    this.assertWorkspace(input.workspaceId);
    const prompt = input.prompt.trim();
    const executionMode = input.executionMode ?? 'single_agent';
    const batchSteps = input.batchSteps ?? [];
    if (executionMode !== 'single_agent' && executionMode !== 'sequential_batch' && executionMode !== 'delegated_leader') {
      throw new Error('Unsupported Planner execution mode.');
    }
    if ((executionMode === 'single_agent' || executionMode === 'delegated_leader') && !prompt) {
      throw new Error('A Planner task requires a prompt.');
    }
    if (executionMode === 'sequential_batch' && (!batchSteps.length || batchSteps.length > 32 || batchSteps.some((step) => !step.trim()))) {
      throw new Error('Sequential Batch requires between 1 and 32 non-empty ordered steps.');
    }
    if (!Number.isInteger(input.priority) || input.priority < 1 || input.priority > 99) {
      throw new Error('Planner priority must be an integer between 1 and 99.');
    }

    const task = this.tasks.create({ ...input, prompt, executionMode, batchSteps: batchSteps.map((step) => step.trim()) });
    this.runs?.schedule();
    return task;
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
