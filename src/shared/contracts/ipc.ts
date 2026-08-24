import type { PlannerTask, Workspace } from '../domain/entities';

export type WorkspaceEntryKind = 'directory' | 'file' | 'symlink';

export interface WorkspaceEntry {
  name: string;
  relativePath: string;
  kind: WorkspaceEntryKind;
}

export interface WorkspaceDirectoryPage {
  entries: WorkspaceEntry[];
  nextOffset: number | null;
}

export interface ListWorkspaceEntriesRequest {
  workspaceId: string;
  relativePath: string;
  offset: number;
  limit: number;
}

export interface CreatePlannerTaskInput {
  workspaceId: string;
  prompt: string;
  requestedAgentId: string | null;
  requestedModelId: string | null;
  priority: number;
}

export interface LauncherConfiguration {
  ideDisplayName: string | null;
  ideConfigured: boolean;
}

export type WorkspaceTool = 'terminal' | 'explorer' | 'ide';

export interface LaunchWorkspaceToolRequest {
  workspaceId: string;
  tool: WorkspaceTool;
}

export interface LaunchResult {
  status: 'launched' | 'configuration_required';
  message: string;
}

export interface BootstrapState {
  appVersion: string;
  workspaces: Workspace[];
  launcherConfiguration: LauncherConfiguration;
}

export const IPC_CHANNELS = {
  appBootstrap: 'app:bootstrap',
  workspaceSelect: 'workspace:select',
  workspaceListEntries: 'workspace:list-entries',
  plannerListTasks: 'planner:list-tasks',
  plannerCreateTask: 'planner:create-task',
  plannerArchiveTask: 'planner:archive-task',
  launcherOpenWorkspaceTool: 'launcher:open-workspace-tool',
  launcherConfigureIde: 'launcher:configure-ide',
  windowMinimize: 'window:minimize',
  windowToggleMaximize: 'window:toggle-maximize',
  windowClose: 'window:close',
} as const;

export interface IpcContract {
  [IPC_CHANNELS.appBootstrap]: { request: undefined; response: BootstrapState };
  [IPC_CHANNELS.workspaceSelect]: { request: undefined; response: Workspace | null };
  [IPC_CHANNELS.workspaceListEntries]: {
    request: ListWorkspaceEntriesRequest;
    response: WorkspaceDirectoryPage;
  };
  [IPC_CHANNELS.plannerListTasks]: { request: { workspaceId: string }; response: PlannerTask[] };
  [IPC_CHANNELS.plannerCreateTask]: { request: CreatePlannerTaskInput; response: PlannerTask };
  [IPC_CHANNELS.plannerArchiveTask]: { request: { taskId: string }; response: PlannerTask };
  [IPC_CHANNELS.launcherOpenWorkspaceTool]: { request: LaunchWorkspaceToolRequest; response: LaunchResult };
  [IPC_CHANNELS.launcherConfigureIde]: { request: undefined; response: LauncherConfiguration };
  [IPC_CHANNELS.windowMinimize]: { request: undefined; response: undefined };
  [IPC_CHANNELS.windowToggleMaximize]: { request: undefined; response: undefined };
  [IPC_CHANNELS.windowClose]: { request: undefined; response: undefined };
}

export type IpcChannel = keyof IpcContract;

export type IpcResult<Value> =
  | { ok: true; value: Value }
  | { ok: false; error: { code: 'OPERATION_FAILED'; message: string } };

export interface NightShiftApi {
  app: {
    bootstrap: () => Promise<BootstrapState>;
  };
  workspace: {
    select: () => Promise<Workspace | null>;
    listEntries: (request: ListWorkspaceEntriesRequest) => Promise<WorkspaceDirectoryPage>;
  };
  planner: {
    listTasks: (workspaceId: string) => Promise<PlannerTask[]>;
    createTask: (input: CreatePlannerTaskInput) => Promise<PlannerTask>;
    archiveTask: (taskId: string) => Promise<PlannerTask>;
  };
  launcher: {
    openWorkspaceTool: (request: LaunchWorkspaceToolRequest) => Promise<LaunchResult>;
    configureIde: () => Promise<LauncherConfiguration>;
  };
  windowControls: {
    minimize: () => Promise<void>;
    toggleMaximize: () => Promise<void>;
    close: () => Promise<void>;
  };
}
