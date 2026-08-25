import type { CreatePlannerTaskInput } from '@shared/contracts/ipc';
import type { PlannerTask } from '@shared/domain/entities';
import type { RunStatus } from '@shared/domain/entities';

import type { PlannerTaskRepository } from '../persistence/repositories/PlannerTaskRepository';
import type { WorkspaceRepository } from '../persistence/repositories/WorkspaceRepository';
import type { PlannerService as PlannerServiceContract } from './contracts/PlannerService';
import type { RunService } from './contracts/RunService';
import type { WorktreeService } from './contracts/WorktreeService';

export class PlannerService implements PlannerServiceContract {
  public constructor(
    private readonly tasks: PlannerTaskRepository,
    private readonly workspaces: WorkspaceRepository,
    private readonly runs?: RunService,
    private readonly worktrees?: WorktreeService,
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
    if (executionMode === 'delegated_leader') {
      throw new Error('Delegated Leader is not available yet.');
    }
    if (executionMode !== 'single_agent' && executionMode !== 'sequential_batch') {
      throw new Error('Unsupported Planner execution mode.');
    }
    if (executionMode === 'single_agent' && !prompt) {
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

  public async deleteTask(taskId: string): Promise<void> {
    const task = this.tasks.findRequired(taskId);
    this.assertWorkspace(task.workspaceId);

    // Check that no associated run is in a non-terminal state
    const nonTerminalStatuses = new Set<RunStatus>(['preparing', 'running', 'cancel_requested']);
    const runs = this.runs ? this.runs.list(task.workspaceId).filter(r => r.taskId === task.id) : [];
    for (const run of runs) {
      if (nonTerminalStatuses.has(run.status)) {
        throw new Error(`Cannot delete task ${taskId} because run ${run.id} is in ${run.status} state.`);
      }
    }

    // For each run, remove the worktree (if exists) and then delete the run
    for (const run of runs) {
      if (run.worktreePath) {
        try {
          await this.worktrees?.removeAfterEvidencePersisted(run.worktreePath);
        } catch (error) {
          // If worktree removal fails, we should not delete the task and should surface the error
          throw new Error(`Failed to remove worktree for run ${run.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      // Delete the run
      this.runs?.deleteRun(run.id);
    }

    // Finally, delete the task and its batch steps
    this.tasks.delete(taskId);
  }

  private assertWorkspace(workspaceId: string): void {
    if (!workspaceId || !this.workspaces.findById(workspaceId)) {
      throw new Error('A valid workspace is required.');
    }
  }
}
