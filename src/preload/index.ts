import { contextBridge, ipcRenderer } from 'electron';

import {
  IPC_CHANNELS,
  type IpcChannel,
  type IpcContract,
  type IpcResult,
  type NightShiftApi,
} from '@shared/contracts/ipc';

const invoke = async <Channel extends IpcChannel>(
  channel: Channel,
  request: IpcContract[Channel]['request'],
): Promise<IpcContract[Channel]['response']> => {
  const result = (await ipcRenderer.invoke(channel, request)) as IpcResult<IpcContract[Channel]['response']>;
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
};

const api: NightShiftApi = {
  app: {
    bootstrap: () => invoke(IPC_CHANNELS.appBootstrap, undefined),
  },
  workspace: {
    select: () => invoke(IPC_CHANNELS.workspaceSelect, undefined),
    saveTabState: (state) => invoke(IPC_CHANNELS.workspaceSaveTabState, state),
    listEntries: (request) => invoke(IPC_CHANNELS.workspaceListEntries, request),
  },
  planner: {
    listTasks: (workspaceId) => invoke(IPC_CHANNELS.plannerListTasks, { workspaceId }),
    createTask: (input) => invoke(IPC_CHANNELS.plannerCreateTask, input),
    archiveTask: (taskId) => invoke(IPC_CHANNELS.plannerArchiveTask, { taskId }),
    selectionCatalog: () => invoke(IPC_CHANNELS.plannerSelectionCatalog, undefined),
  },
  runs: {
    list: (workspaceId) => invoke(IPC_CHANNELS.runsList, { workspaceId }),
    events: (runId) => invoke(IPC_CHANNELS.runsEvents, { runId }),
    batchSteps: (runId) => invoke(IPC_CHANNELS.runsBatchSteps, { runId }),
    cancel: (runId) => invoke(IPC_CHANNELS.runsCancel, { runId }),
  },
  workers: {
    list: (workspaceId) => invoke(IPC_CHANNELS.workersList, { workspaceId }),
    create: (input) => invoke(IPC_CHANNELS.workersCreate, input),
    events: (workerId) => invoke(IPC_CHANNELS.workersEvents, { workerId }),
    send: (workerId, message) => invoke(IPC_CHANNELS.workersSend, { workerId, message }),
    stop: (workerId) => invoke(IPC_CHANNELS.workersStop, { workerId }),
    selectionCatalog: () => invoke(IPC_CHANNELS.workersSelectionCatalog, undefined),
  },
  launcher: {
    openWorkspaceTool: (request) => invoke(IPC_CHANNELS.launcherOpenWorkspaceTool, request),
    configureIde: () => invoke(IPC_CHANNELS.launcherConfigureIde, undefined),
  },
  windowControls: {
    minimize: () => invoke(IPC_CHANNELS.windowMinimize, undefined),
    toggleMaximize: () => invoke(IPC_CHANNELS.windowToggleMaximize, undefined),
    close: () => invoke(IPC_CHANNELS.windowClose, undefined),
  },
};

contextBridge.exposeInMainWorld('nightShift', api);
