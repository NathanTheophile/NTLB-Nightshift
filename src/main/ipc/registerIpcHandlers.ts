import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';

import {
  IPC_CHANNELS,
  type CreatePlannerTaskInput,
  type IpcChannel,
  type IpcContract,
  type IpcResult,
  type ListWorkspaceEntriesRequest,
  type LaunchWorkspaceToolRequest,
  type WorkspaceTabState,
} from '@shared/contracts/ipc';

import type { LauncherService } from '../services/LauncherService';
import type { PlannerService } from '../services/PlannerService';
import type { RunService } from '../services/contracts/RunService';
import type { WorkspaceService } from '../services/WorkspaceService';

interface IpcServices {
  appVersion: string;
  workspaces: WorkspaceService;
  planner: PlannerService;
  runs: RunService;
  launcher: LauncherService;
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

  handle(IPC_CHANNELS.runsList, (request) => {
    assertRecord(request);
    assertNonEmptyString(request.workspaceId, 'workspaceId');
    return services.runs.list(request.workspaceId);
  });

  handle(IPC_CHANNELS.runsEvents, (request) => {
    assertRecord(request);
    assertNonEmptyString(request.runId, 'runId');
    return services.runs.events(request.runId);
  });

  handle(IPC_CHANNELS.runsCancel, async (request) => {
    assertRecord(request);
    assertNonEmptyString(request.runId, 'runId');
    return services.runs.requestCancellation(request.runId);
  });

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

function assertCreateTaskInput(value: unknown): asserts value is CreatePlannerTaskInput {
  assertRecord(value);
  assertNonEmptyString(value.workspaceId, 'workspaceId');
  assertNonEmptyString(value.prompt, 'prompt');
  assertNullableString(value.requestedAgentId, 'requestedAgentId');
  assertNullableString(value.requestedModelId, 'requestedModelId');
  if (!Number.isInteger(value.priority) || (value.priority as number) < 1 || (value.priority as number) > 99) {
    throw new Error('priority must be an integer between 1 and 99.');
  }
}

function assertLaunchRequest(value: unknown): asserts value is LaunchWorkspaceToolRequest {
  assertRecord(value);
  assertNonEmptyString(value.workspaceId, 'workspaceId');
  if (value.tool !== 'terminal' && value.tool !== 'explorer' && value.tool !== 'ide') {
    throw new Error('Unsupported workspace tool.');
  }
}

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
