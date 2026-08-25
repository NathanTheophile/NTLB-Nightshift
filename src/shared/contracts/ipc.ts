import type { AgentDescriptor, BatchStep, ModelDescriptor, PlannerExecutionMode, PlannerTask, Run, RunEvent, WorkerConversation, WorkerEvent, WorkerPermissionProfile, IsolationMode, Workspace } from '../domain/entities';

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
  executionMode?: PlannerExecutionMode;
  batchSteps?: string[];
  priority: number;
}

export interface PlannerSelectionCatalog {
  agents: readonly AgentDescriptor[];
  modelsByAgent: Readonly<Record<string, readonly ModelDescriptor[]>>;
  defaultAgentId: string;
  defaultModelId: string;
}

export interface CreateWorkerInput { workspaceId: string; title: string; agentId: string; modelId: string; permissionProfile: WorkerPermissionProfile; isolationMode: IsolationMode; }
export interface WorkerSelectionCatalog { agents: readonly AgentDescriptor[]; modelsByAgent: Readonly<Record<string, readonly ModelDescriptor[]>>; }

export interface LauncherConfiguration {
  ideDisplayName: string | null;
  ideConfigured: boolean;
}

export interface WorkspaceTabState {
  workspaceIds: string[];
  activeWorkspaceId: string | null;
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
  activeWorkspaceId: string | null;
  launcherConfiguration: LauncherConfiguration;
}

export const IPC_CHANNELS = {
  appBootstrap: 'app:bootstrap',
  workspaceSelect: 'workspace:select',
  workspaceSaveTabState: 'workspace:save-tab-state',
  workspaceListEntries: 'workspace:list-entries',
  plannerListTasks: 'planner:list-tasks',
  plannerCreateTask: 'planner:create-task',
  plannerArchiveTask: 'planner:archive-task',
  plannerSelectionCatalog: 'planner:selection-catalog',
  runsList: 'runs:list',
  runsEvents: 'runs:events',
  runsBatchSteps: 'runs:batch-steps',
  runsCancel: 'runs:cancel',
  workersList: 'workers:list',
  workersCreate: 'workers:create',
  workersEvents: 'workers:events',
  workersSend: 'workers:send',
  workersStop: 'workers:stop',
  workersSelectionCatalog: 'workers:selection-catalog',
  launcherOpenWorkspaceTool: 'launcher:open-workspace-tool',
  launcherConfigureIde: 'launcher:configure-ide',
  windowMinimize: 'window:minimize',
  windowToggleMaximize: 'window:toggle-maximize',
  windowClose: 'window:close',
} as const;

export interface IpcContract {
  [IPC_CHANNELS.appBootstrap]: { request: undefined; response: BootstrapState };
  [IPC_CHANNELS.workspaceSelect]: { request: undefined; response: Workspace | null };
  [IPC_CHANNELS.workspaceSaveTabState]: { request: WorkspaceTabState; response: undefined };
  [IPC_CHANNELS.workspaceListEntries]: {
    request: ListWorkspaceEntriesRequest;
    response: WorkspaceDirectoryPage;
  };
  [IPC_CHANNELS.plannerListTasks]: { request: { workspaceId: string }; response: PlannerTask[] };
  [IPC_CHANNELS.plannerCreateTask]: { request: CreatePlannerTaskInput; response: PlannerTask };
  [IPC_CHANNELS.plannerArchiveTask]: { request: { taskId: string }; response: PlannerTask };
  [IPC_CHANNELS.plannerSelectionCatalog]: { request: undefined; response: PlannerSelectionCatalog };
  [IPC_CHANNELS.runsList]: { request: { workspaceId: string }; response: Run[] };
  [IPC_CHANNELS.runsEvents]: { request: { runId: string }; response: RunEvent[] };
  [IPC_CHANNELS.runsBatchSteps]: { request: { runId: string }; response: BatchStep[] };
  [IPC_CHANNELS.runsCancel]: { request: { runId: string }; response: Run };
  [IPC_CHANNELS.workersList]: { request: { workspaceId: string }; response: WorkerConversation[] };
  [IPC_CHANNELS.workersCreate]: { request: CreateWorkerInput; response: WorkerConversation };
  [IPC_CHANNELS.workersEvents]: { request: { workerId: string }; response: WorkerEvent[] };
  [IPC_CHANNELS.workersSend]: { request: { workerId: string; message: string }; response: WorkerConversation };
  [IPC_CHANNELS.workersStop]: { request: { workerId: string }; response: WorkerConversation };
  [IPC_CHANNELS.workersSelectionCatalog]: { request: undefined; response: WorkerSelectionCatalog };
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
    saveTabState: (state: WorkspaceTabState) => Promise<void>;
    listEntries: (request: ListWorkspaceEntriesRequest) => Promise<WorkspaceDirectoryPage>;
  };
  planner: {
    listTasks: (workspaceId: string) => Promise<PlannerTask[]>;
    createTask: (input: CreatePlannerTaskInput) => Promise<PlannerTask>;
    archiveTask: (taskId: string) => Promise<PlannerTask>;
    selectionCatalog: () => Promise<PlannerSelectionCatalog>;
  };
  runs: {
    list: (workspaceId: string) => Promise<Run[]>;
    events: (runId: string) => Promise<RunEvent[]>;
    batchSteps: (runId: string) => Promise<BatchStep[]>;
    cancel: (runId: string) => Promise<Run>;
  };
  workers: {
    list: (workspaceId: string) => Promise<WorkerConversation[]>;
    create: (input: CreateWorkerInput) => Promise<WorkerConversation>;
    events: (workerId: string) => Promise<WorkerEvent[]>;
    send: (workerId: string, message: string) => Promise<WorkerConversation>;
    stop: (workerId: string) => Promise<WorkerConversation>;
    selectionCatalog: () => Promise<WorkerSelectionCatalog>;
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
