import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';

import {
  IPC_CHANNELS,
  type CreatePlannerTaskInput,
  type IpcChannel,
  type IpcContract,
  type IpcResult,
  type ListRunEventsRequest,
  type ListWorkspaceEntriesRequest,
  type LaunchWorkspaceToolRequest,
  type WorkspaceTabState,
  type CreateWorkerInput,
} from '@shared/contracts/ipc';
import type { RunReviewExportKind } from '@shared/domain/entities';

import type { LauncherService } from '../services/LauncherService';
import type { PlannerService } from '../services/PlannerService';
import type { RunService } from '../services/contracts/RunService';
import type { WorkspaceService } from '../services/WorkspaceService';
import type { WorkerSessionService } from '../services/contracts/WorkerSessionService';
import type { RunReviewService } from '../services/RunReviewService';
import type { ReviewIntegrationService } from '../services/ReviewIntegrationService';

interface IpcServices {
  appVersion: string;
  workspaces: WorkspaceService;
  planner: PlannerService;
  plannerSelectionCatalog: () => Promise<IpcContract[typeof IPC_CHANNELS.plannerSelectionCatalog]['response']>;
  runs: RunService;
  reviews: RunReviewService;
  reviewIntegration: ReviewIntegrationService;
  launcher: LauncherService;
  workers: WorkerSessionService & { createConversation(input: CreateWorkerInput): Promise<IpcContract[typeof IPC_CHANNELS.workersCreate]['response']> };
  workerSelectionCatalog: () => Promise<IpcContract[typeof IPC_CHANNELS.workersSelectionCatalog]['response']>;
}

type Handler<Channel extends IpcChannel> = (
  request: IpcContract[Channel]['request'],
  event: IpcMainInvokeEvent,
) => Promise<IpcContract[Channel]['response']> | IpcContract[Channel]['response'];

export const registerIpcHandlers = (services: IpcServices): void => {
  handle(IPC_CHANNELS.appBootstrap, () => {
    const tabs = services.workspaces.getOpenTabs();
    return {
      appVersion: services.appVersion,
      workspaces: tabs.workspaces,
      activeWorkspaceId: tabs.activeWorkspaceId,
      launcherConfiguration: services.launcher.getConfiguration(),
    };
  });

  handle(IPC_CHANNELS.workspaceSelect, async (_, event) =>
    services.workspaces.select(requireWindow(event)),
  );

  handle(IPC_CHANNELS.workspaceSaveTabState, (request) => {
    assertWorkspaceTabState(request);
    services.workspaces.saveTabState(request);
    return undefined;
  });

  handle(IPC_CHANNELS.workspaceListEntries, async (request) => {
    assertListEntriesRequest(request);
    return services.workspaces.listEntries(request);
  });

  handle(IPC_CHANNELS.plannerListTasks, (request) => {
    assertRecord(request);
    assertNonEmptyString(request.workspaceId, 'workspaceId');
    return services.planner.listTasks(request.workspaceId);
  });

  handle(IPC_CHANNELS.plannerCreateTask, (request) => {
    assertCreateTaskInput(request);
    return services.planner.createTask(request);
  });

  handle(IPC_CHANNELS.plannerArchiveTask, (request) => {
    assertRecord(request);
    assertNonEmptyString(request.taskId, 'taskId');
    return services.planner.archiveTask(request.taskId);
  });

  handle(IPC_CHANNELS.plannerSelectionCatalog, () => services.plannerSelectionCatalog());
  handle(IPC_CHANNELS.plannerGetConcurrency, () => ({ limit: services.runs.concurrencyLimit() as 1 | 2 | 3 | 4 }));
  handle(IPC_CHANNELS.plannerSetConcurrency, (request) => {
    assertRecord(request);
    if (request.limit !== 1 && request.limit !== 2 && request.limit !== 3 && request.limit !== 4) throw new Error('limit must be between 1 and 4.');
    return { limit: services.runs.setConcurrencyLimit(request.limit) as 1 | 2 | 3 | 4 };
  });
  handle(IPC_CHANNELS.plannerGetRunTimeout, () => ({ timeoutMs: services.runs.timeoutMs() as 1_800_000 | 3_600_000 | 5_400_000 | 7_200_000 }));
  handle(IPC_CHANNELS.plannerSetRunTimeout, (request) => {
    assertRecord(request);
    if (request.timeoutMs !== 30 * 60_000 && request.timeoutMs !== 60 * 60_000 && request.timeoutMs !== 90 * 60_000 && request.timeoutMs !== 120 * 60_000) throw new Error('timeoutMs must be 30, 60, 90, or 120 minutes.');
    return { timeoutMs: services.runs.setTimeoutMs(request.timeoutMs) as 1_800_000 | 3_600_000 | 5_400_000 | 7_200_000 };
  });

  handle(IPC_CHANNELS.runsList, (request) => {
    assertRecord(request);
    assertNonEmptyString(request.workspaceId, 'workspaceId');
    return services.runs.list(request.workspaceId);
  });
  handle(IPC_CHANNELS.runsNavigation, (request) => {
    assertRecord(request);
    assertNonEmptyString(request.workspaceId, 'workspaceId');
    return services.runs.navigation(request.workspaceId);
  });

  handle(IPC_CHANNELS.runsEvents, (request) => {
    assertListRunEventsRequest(request);
    return services.runs.events(request.runId, request.kind, request.cursor ?? null, request.limit ?? 100);
  });
  handle(IPC_CHANNELS.runsBatchSteps, (request) => {
    assertRecord(request);
    assertNonEmptyString(request.runId, 'runId');
    return services.runs.batchSteps(request.runId);
  });

  handle(IPC_CHANNELS.runsCancel, async (request) => {
    assertRecord(request);
    assertNonEmptyString(request.runId, 'runId');
    return services.runs.requestCancellation(request.runId);
  });
  handle(IPC_CHANNELS.runsReview, (request) => { assertRecord(request); assertNonEmptyString(request.runId, 'runId'); return services.reviews.inspect(request.runId); });
  handle(IPC_CHANNELS.runsFileDiff, (request) => { assertRecord(request); assertNonEmptyString(request.runId, 'runId'); assertSafeRelativePath(request.path); return services.reviews.fileDiff(request.runId, request.path); });
  handle(IPC_CHANNELS.runsOpenWorktree, (request) => { assertRecord(request); assertNonEmptyString(request.runId, 'runId'); assertWorkspaceTool(request.tool); return services.launcher.openRunWorktreeTool(request.runId, request.tool); });
  handle(IPC_CHANNELS.runsExportReview, async (request, event) => {
    assertRecord(request); assertNonEmptyString(request.runId, 'runId'); assertExportKind(request.kind);
    const defaultPath = services.reviews.suggestedFileName(request.runId, request.kind);
    const result = await dialog.showSaveDialog(requireWindow(event), { title: 'Export Run review', defaultPath, filters: [{ name: request.kind === 'bundle' ? 'ZIP bundle' : request.kind === 'json' ? 'JSON' : 'Markdown', extensions: [request.kind === 'bundle' ? 'zip' : request.kind === 'json' ? 'json' : 'md'] }] });
    return result.canceled || !result.filePath ? null : services.reviews.exportTo(request.runId, request.kind, result.filePath);
  });
  handle(IPC_CHANNELS.runsPublishCandidate, async (request) => {
    assertRecord(request);
    assertNonEmptyString(request.runId, 'runId');
    return services.runs.publishCandidate(request.runId);
  });
  handle(IPC_CHANNELS.runsCreateFollowUp, async (request) => {
    assertRecord(request);
    assertNonEmptyString(request.runId, 'runId');
    assertNonEmptyString(request.prompt, 'prompt');
    return services.runs.createFollowUp(request.runId, request.prompt);
  });
  handle(IPC_CHANNELS.runsReviewIntegration, (request) => { assertRecord(request); assertNonEmptyString(request.runId, 'runId'); return services.reviewIntegration.latest(request.runId) ?? null; });
  handle(IPC_CHANNELS.runsRequestReview, async (request) => { assertRecord(request); assertNonEmptyString(request.runId, 'runId'); return services.reviewIntegration.requestReview(request.runId); });
  handle(IPC_CHANNELS.runsIntegrateReview, async (request) => { assertRecord(request); assertNonEmptyString(request.reviewId, 'reviewId'); return services.reviewIntegration.integrate(request.reviewId); });
  handle(IPC_CHANNELS.workersList, (request) => { assertRecord(request); assertNonEmptyString(request.workspaceId, 'workspaceId'); return services.workers.list(request.workspaceId); });
  handle(IPC_CHANNELS.workersCreate, (request) => { assertCreateWorkerInput(request); return services.workers.createConversation(request); });
  handle(IPC_CHANNELS.workersEvents, (request) => { assertRecord(request); assertNonEmptyString(request.workerId, 'workerId'); return services.workers.events(request.workerId); });
  handle(IPC_CHANNELS.workersSend, (request) => { assertRecord(request); assertNonEmptyString(request.workerId, 'workerId'); assertNonEmptyString(request.message, 'message'); return services.workers.send(request.workerId, request.message); });
  handle(IPC_CHANNELS.workersStop, (request) => { assertRecord(request); assertNonEmptyString(request.workerId, 'workerId'); return services.workers.terminate(request.workerId); });
  handle(IPC_CHANNELS.workersSelectionCatalog, () => services.workerSelectionCatalog());

  handle(IPC_CHANNELS.launcherOpenWorkspaceTool, async (request) => {
    assertLaunchRequest(request);
    return services.launcher.openWorkspaceTool(request.workspaceId, request.tool);
  });

  handle(IPC_CHANNELS.launcherConfigureIde, (_, event) =>
    services.launcher.configureIde(requireWindow(event)),
  );

  handle(IPC_CHANNELS.windowMinimize, (_, event) => {
    requireWindow(event).minimize();
    return undefined;
  });

  handle(IPC_CHANNELS.windowToggleMaximize, (_, event) => {
    const window = requireWindow(event);
    if (window.isMaximized()) {
      window.unmaximize();
    } else {
      window.maximize();
    }
    return undefined;
  });

  handle(IPC_CHANNELS.windowClose, (_, event) => {
    requireWindow(event).close();
    return undefined;
  });
};

const handle = <Channel extends IpcChannel>(channel: Channel, handler: Handler<Channel>): void => {
  ipcMain.handle(channel, async (event, request: IpcContract[Channel]['request']) => {
    try {
      const value = await handler(request, event);
      return { ok: true, value } satisfies IpcResult<IpcContract[Channel]['response']>;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'NightShift could not complete the operation.';
      console.error(`[IPC:${channel}]`, error);
      return {
        ok: false,
        error: { code: 'OPERATION_FAILED', message },
      } satisfies IpcResult<IpcContract[Channel]['response']>;
    }
  });
};

const requireWindow = (event: IpcMainInvokeEvent): BrowserWindow => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || window.isDestroyed()) {
    throw new Error('The NightShift window is no longer available.');
  }
  return window;
};

function assertListEntriesRequest(value: unknown): asserts value is ListWorkspaceEntriesRequest {
  assertRecord(value);
  assertNonEmptyString(value.workspaceId, 'workspaceId');
  if (typeof value.relativePath !== 'string') {
    throw new Error('relativePath must be a string.');
  }
  if (!Number.isInteger(value.offset) || (value.offset as number) < 0) {
    throw new Error('offset must be a non-negative integer.');
  }
  if (!Number.isInteger(value.limit) || (value.limit as number) < 1 || (value.limit as number) > 250) {
    throw new Error('limit must be an integer between 1 and 250.');
  }
}

function assertListRunEventsRequest(value: unknown): asserts value is ListRunEventsRequest {
  assertRecord(value); assertNonEmptyString(value.runId, 'runId');
  if (value.kind !== 'activity' && value.kind !== 'raw_protocol') throw new Error('Unsupported Run event kind.');
  if (value.cursor !== undefined && value.cursor !== null && (typeof value.cursor !== 'number' || !Number.isInteger(value.cursor) || value.cursor < 0)) throw new Error('cursor must be a non-negative event sequence.');
  if (value.limit !== undefined && (typeof value.limit !== 'number' || !Number.isInteger(value.limit) || value.limit < 1 || value.limit > 200)) throw new Error('limit must be an integer between 1 and 200.');
}

function assertCreateTaskInput(value: unknown): asserts value is CreatePlannerTaskInput {
  assertRecord(value);
  assertNonEmptyString(value.workspaceId, 'workspaceId');
  if (typeof value.prompt !== 'string') {
    throw new Error('prompt must be a string.');
  }
  assertNullableString(value.requestedAgentId, 'requestedAgentId');
  assertNullableString(value.requestedModelId, 'requestedModelId');
  if (value.executionMode === undefined) value.executionMode = 'single_agent';
  if (value.batchSteps === undefined) value.batchSteps = [];
  if (value.executionMode !== 'single_agent' && value.executionMode !== 'sequential_batch') {
    throw new Error('Unsupported Planner execution mode.');
  }
  if (!Array.isArray(value.batchSteps) || value.batchSteps.length > 32 || !value.batchSteps.every((step) => typeof step === 'string')) {
    throw new Error('batchSteps must contain at most 32 strings.');
  }
  if (value.executionMode === 'single_agent' && value.batchSteps.length) {
    throw new Error('Single Agent tasks cannot include batch steps.');
  }
  if (value.executionMode === 'sequential_batch' && (!value.batchSteps.length || value.batchSteps.some((step) => !step.trim()))) {
    throw new Error('Sequential Batch requires non-empty steps.');
  }
  if (!Number.isInteger(value.priority) || (value.priority as number) < 1 || (value.priority as number) > 99) {
    throw new Error('priority must be an integer between 1 and 99.');
  }
}

function assertCreateWorkerInput(value: unknown): asserts value is CreateWorkerInput {
  assertRecord(value); assertNonEmptyString(value.workspaceId, 'workspaceId'); assertNonEmptyString(value.title, 'title'); assertNonEmptyString(value.agentId, 'agentId'); assertNonEmptyString(value.modelId, 'modelId');
  if (value.permissionProfile !== 'read_only' && value.permissionProfile !== 'workspace_write' && value.permissionProfile !== 'isolated_write') throw new Error('Unsupported Worker permission profile.');
  if (value.isolationMode !== 'direct_workspace' && value.isolationMode !== 'isolated_worktree') throw new Error('Unsupported Worker isolation mode.');
}

function assertLaunchRequest(value: unknown): asserts value is LaunchWorkspaceToolRequest {
  assertRecord(value);
  assertNonEmptyString(value.workspaceId, 'workspaceId');
  assertWorkspaceTool(value.tool);
}

function assertWorkspaceTool(value: unknown): asserts value is 'terminal' | 'explorer' | 'ide' { if (value !== 'terminal' && value !== 'explorer' && value !== 'ide') throw new Error('Unsupported workspace tool.'); }
function assertExportKind(value: unknown): asserts value is RunReviewExportKind { if (value !== 'markdown' && value !== 'json' && value !== 'bundle') throw new Error('Unsupported Run review export format.'); }
function assertSafeRelativePath(value: unknown): asserts value is string { assertNonEmptyString(value, 'path'); if (value.includes('\0') || value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:/.test(value) || value.split(/[\\/]/).includes('..')) throw new Error('path must be a safe relative Run file path.'); }

function assertWorkspaceTabState(value: unknown): asserts value is WorkspaceTabState {
  assertRecord(value);
  if (!Array.isArray(value.workspaceIds) || !value.workspaceIds.every((id) => typeof id === 'string' && id.trim())) {
    throw new Error('workspaceIds must contain only non-empty strings.');
  }
  if (value.workspaceIds.length > 100) {
    throw new Error('No more than 100 workspace tabs can be open.');
  }
  if (value.activeWorkspaceId !== null && (typeof value.activeWorkspaceId !== 'string' || !value.activeWorkspaceId.trim())) {
    throw new Error('activeWorkspaceId must be null or a non-empty string.');
  }
}

function assertRecord(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid IPC request payload.');
  }
}

function assertNonEmptyString(value: unknown, fieldName: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${fieldName} must be a non-empty string.`);
  }
}

function assertNullableString(value: unknown, fieldName: string): asserts value is string | null {
  if (value !== null && (typeof value !== 'string' || !value.trim())) {
    throw new Error(`${fieldName} must be null or a non-empty string.`);
  }
}
