import type { AgentDescriptor, BatchStep, ModelDescriptor, PlannerExecutionMode, PlannerTask, Run, RunEventPage, RunFileDiff, RunIntegrationReview, RunReview, RunReviewExportKind, RunReviewExportResult, RunStatus, WorkerConversation, WorkerEvent, WorkerPermissionProfile, IsolationMode, Workspace } from '../domain/entities';

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
export interface PlannerConcurrencySettings { limit: 1 | 2 | 3 | 4; }
export interface PlannerRunTimeoutSettings { timeoutMs: 1_800_000 | 3_600_000 | 5_400_000 | 7_200_000; }
export interface PlannerQueueSettings { paused: boolean; }
export type CandidateProgressionMode = 'candidate_only' | 'auto_review' | 'auto_review_integrate';
export interface CandidateProgressionSettings { workspaceId: string; mode: CandidateProgressionMode; }

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

export interface LaunchFileRequest {
  workspaceId: string;
  filePath: string;
}

export interface LaunchResult {
  status: 'launched' | 'configuration_required';
  message: string;
}
export interface ListRunEventsRequest { runId: string; kind: 'activity' | 'raw_protocol'; cursor?: number | null; limit?: number; }
export interface RunNavigationItem { id: string; taskId: string; taskTitle: string; status: RunStatus; createdAt: string; resolvedAgentId: string; resolvedModelId: string; }

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
  plannerDeleteQueuedTask: 'planner:delete-queued-task',
  plannerUpdateQueuedPriority: 'planner:update-queued-priority',
  plannerPurgeTask: 'planner:purge-task',
  plannerSelectionCatalog: 'planner:selection-catalog',
  plannerGetConcurrency: 'planner:get-concurrency',
  plannerSetConcurrency: 'planner:set-concurrency',
  plannerGetRunTimeout: 'planner:get-run-timeout',
  plannerSetRunTimeout: 'planner:set-run-timeout',
  plannerGetQueueState: 'planner:get-queue-state',
  plannerSetQueueState: 'planner:set-queue-state',
  runsList: 'runs:list',
  runsNavigation: 'runs:navigation',
  runsEvents: 'runs:events',
  runsBatchSteps: 'runs:batch-steps',
  runsReview: 'runs:review',
  runsFileDiff: 'runs:file-diff',
  runsOpenWorktree: 'runs:open-worktree',
  runsExportReview: 'runs:export-review',
  runsCancel: 'runs:cancel',
  runsPublishCandidate: 'runs:publish-candidate',
  runsCreateFollowUp: 'runs:create-follow-up',
  runsReviewIntegration: 'runs:review-integration',
  runsRequestReview: 'runs:request-review',
  runsIntegrateReview: 'runs:integrate-review',
  runsGetCandidateProgression: 'runs:get-candidate-progression',
  runsSetCandidateProgression: 'runs:set-candidate-progression',
  workersList: 'workers:list',
  workersCreate: 'workers:create',
  workersEvents: 'workers:events',
  workersSend: 'workers:send',
  workersStop: 'workers:stop',
  workersSelectionCatalog: 'workers:selection-catalog',
  launcherOpenWorkspaceTool: 'launcher:open-workspace-tool',
  launcherOpenFile: 'launcher:open-file',
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
  [IPC_CHANNELS.plannerDeleteQueuedTask]: { request: { taskId: string }; response: undefined };
  [IPC_CHANNELS.plannerUpdateQueuedPriority]: { request: { taskId: string; priority: number }; response: PlannerTask };
  [IPC_CHANNELS.plannerPurgeTask]: { request: { taskId: string }; response: undefined };
  [IPC_CHANNELS.plannerSelectionCatalog]: { request: undefined; response: PlannerSelectionCatalog };
  [IPC_CHANNELS.plannerGetConcurrency]: { request: undefined; response: PlannerConcurrencySettings };
  [IPC_CHANNELS.plannerSetConcurrency]: { request: PlannerConcurrencySettings; response: PlannerConcurrencySettings };
  [IPC_CHANNELS.plannerGetRunTimeout]: { request: undefined; response: PlannerRunTimeoutSettings };
  [IPC_CHANNELS.plannerSetRunTimeout]: { request: PlannerRunTimeoutSettings; response: PlannerRunTimeoutSettings };
  [IPC_CHANNELS.plannerGetQueueState]: { request: undefined; response: PlannerQueueSettings };
  [IPC_CHANNELS.plannerSetQueueState]: { request: PlannerQueueSettings; response: PlannerQueueSettings };
  [IPC_CHANNELS.runsList]: { request: { workspaceId: string }; response: Run[] };
  [IPC_CHANNELS.runsNavigation]: { request: { workspaceId: string }; response: RunNavigationItem[] };
  [IPC_CHANNELS.runsEvents]: { request: ListRunEventsRequest; response: RunEventPage };
  [IPC_CHANNELS.runsBatchSteps]: { request: { runId: string }; response: BatchStep[] };
  [IPC_CHANNELS.runsReview]: { request: { runId: string }; response: RunReview };
  [IPC_CHANNELS.runsFileDiff]: { request: { runId: string; path: string }; response: RunFileDiff };
  [IPC_CHANNELS.runsOpenWorktree]: { request: { runId: string; tool: WorkspaceTool }; response: LaunchResult };
  [IPC_CHANNELS.runsExportReview]: { request: { runId: string; kind: RunReviewExportKind }; response: RunReviewExportResult | null };
  [IPC_CHANNELS.runsCancel]: { request: { runId: string }; response: Run };
  [IPC_CHANNELS.runsPublishCandidate]: { request: { runId: string }; response: Run };
  [IPC_CHANNELS.runsCreateFollowUp]: { request: { runId: string; prompt: string }; response: Run };
  [IPC_CHANNELS.runsReviewIntegration]: { request: { runId: string }; response: RunIntegrationReview | null };
  [IPC_CHANNELS.runsRequestReview]: { request: { runId: string }; response: RunIntegrationReview };
  [IPC_CHANNELS.runsIntegrateReview]: { request: { reviewId: string }; response: RunIntegrationReview };
  [IPC_CHANNELS.runsGetCandidateProgression]: { request: { workspaceId: string }; response: CandidateProgressionSettings };
  [IPC_CHANNELS.runsSetCandidateProgression]: { request: CandidateProgressionSettings; response: CandidateProgressionSettings };
  [IPC_CHANNELS.workersList]: { request: { workspaceId: string }; response: WorkerConversation[] };
  [IPC_CHANNELS.workersCreate]: { request: CreateWorkerInput; response: WorkerConversation };
  [IPC_CHANNELS.workersEvents]: { request: { workerId: string }; response: WorkerEvent[] };
  [IPC_CHANNELS.workersSend]: { request: { workerId: string; message: string }; response: WorkerConversation };
  [IPC_CHANNELS.workersStop]: { request: { workerId: string }; response: WorkerConversation };
  [IPC_CHANNELS.workersSelectionCatalog]: { request: undefined; response: WorkerSelectionCatalog };
  [IPC_CHANNELS.launcherOpenWorkspaceTool]: { request: LaunchWorkspaceToolRequest; response: LaunchResult };
  [IPC_CHANNELS.launcherOpenFile]: { request: LaunchFileRequest; response: LaunchResult };
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
    deleteQueuedTask: (taskId: string) => Promise<void>;
    updateQueuedPriority: (taskId: string, priority: number) => Promise<PlannerTask>;
    purgeTask: (taskId: string) => Promise<void>;
    selectionCatalog: () => Promise<PlannerSelectionCatalog>;
    getConcurrency: () => Promise<PlannerConcurrencySettings>;
    setConcurrency: (limit: 1 | 2 | 3 | 4) => Promise<PlannerConcurrencySettings>;
    getRunTimeout: () => Promise<PlannerRunTimeoutSettings>;
    setRunTimeout: (timeoutMs: PlannerRunTimeoutSettings['timeoutMs']) => Promise<PlannerRunTimeoutSettings>;
    getQueueState: () => Promise<PlannerQueueSettings>;
    setQueueState: (paused: boolean) => Promise<PlannerQueueSettings>;
  };
  runs: {
    list: (workspaceId: string) => Promise<Run[]>;
    navigation: (workspaceId: string) => Promise<RunNavigationItem[]>;
    events: (request: ListRunEventsRequest) => Promise<RunEventPage>;
    batchSteps: (runId: string) => Promise<BatchStep[]>;
    review: (runId: string) => Promise<RunReview>;
    fileDiff: (runId: string, path: string) => Promise<RunFileDiff>;
    openWorktree: (runId: string, tool: WorkspaceTool) => Promise<LaunchResult>;
    exportReview: (runId: string, kind: RunReviewExportKind) => Promise<RunReviewExportResult | null>;
    cancel: (runId: string) => Promise<Run>;
    publishCandidate: (runId: string) => Promise<Run>;
    createFollowUp: (runId: string, prompt: string) => Promise<Run>;
    reviewIntegration: (runId: string) => Promise<RunIntegrationReview | null>;
    requestReview: (runId: string) => Promise<RunIntegrationReview>;
    integrateReview: (reviewId: string) => Promise<RunIntegrationReview>;
    getCandidateProgression: (workspaceId: string) => Promise<CandidateProgressionSettings>;
    setCandidateProgression: (workspaceId: string, mode: CandidateProgressionMode) => Promise<CandidateProgressionSettings>;
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
    openFile: (request: LaunchFileRequest) => Promise<LaunchResult>;
    configureIde: () => Promise<LauncherConfiguration>;
  };
  windowControls: {
    minimize: () => Promise<void>;
    toggleMaximize: () => Promise<void>;
    close: () => Promise<void>;
  };
}
