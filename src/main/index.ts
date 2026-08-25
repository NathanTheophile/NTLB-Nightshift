import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { app, BrowserWindow } from 'electron';

import { registerIpcHandlers } from './ipc/registerIpcHandlers';
import { DatabaseService } from './persistence/DatabaseService';
import { PlannerTaskRepository } from './persistence/repositories/PlannerTaskRepository';
import { RunRepository } from './persistence/repositories/RunRepository';
import { WorkerRepository } from './persistence/repositories/WorkerRepository';
import { SettingsRepository } from './persistence/repositories/SettingsRepository';
import { WorkspaceRepository } from './persistence/repositories/WorkspaceRepository';
import { LauncherService } from './services/LauncherService';
import { PlannerService } from './services/PlannerService';
import { RunService } from './services/RunService';
import { GitWorktreeService } from './services/GitWorktreeService';
import { WindowsProcessSupervisor } from './services/WindowsProcessSupervisor';
import { WorkspaceService } from './services/WorkspaceService';
import { ClaudeCodeAdapter } from './services/agents/ClaudeCodeAdapter';
import { CodexAdapter } from './services/agents/CodexAdapter';
import { AgentRegistry } from './services/AgentRegistry';
import type { AgentAdapter } from './services/contracts/AgentAdapter';
import type { FccHealth } from './services/contracts/FccGateway';
import { FccRuntimeManager } from './services/runtime/FccRuntimeManager';
import { LocalFccGateway } from './services/runtime/LocalFccGateway';
import { WorkerSessionService } from './services/WorkerSessionService';

const currentDirectory = fileURLToPath(new URL('.', import.meta.url));
let database: DatabaseService | undefined;
let runtime: RuntimeContext | undefined;
let shutdownStarted = false;

interface RuntimeContext {
  fccGateway: LocalFccGateway;
  claudeCode: ClaudeCodeAdapter;
  codex: CodexAdapter;
  agentRegistry: AgentRegistry;
  availability: Promise<FccHealth>;
}

const createWindow = (): BrowserWindow => {
  const window = new BrowserWindow({
    width: 1600,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    frame: false,
    backgroundColor: '#1a171f',
    title: 'NightShift',
    webPreferences: {
      preload: join(currentDirectory, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
    },
  });

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('console-message', (details) => {
    if (details.level === 'warning' || details.level === 'error') {
      console.error(`[Renderer:${details.level}] ${details.message} (${details.sourceId}:${details.lineNumber})`);
    }
  });
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
    if (isMainFrame) {
      console.error(`[Renderer:load] ${errorCode} ${errorDescription} (${validatedUrl})`);
    }
  });
  window.webContents.on('will-navigate', (event, navigationUrl) => {
    if (navigationUrl !== window.webContents.getURL()) {
      event.preventDefault();
    }
  });
  window.once('ready-to-show', () => window.show());

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) {
    void window.loadURL(rendererUrl);
  } else {
    void window.loadFile(join(currentDirectory, '../renderer/index.html'));
  }

  return window;
};

void app.whenReady().then(() => {
  app.setAppUserModelId('com.nightshift.desktop');

  database = new DatabaseService(join(app.getPath('userData'), 'nightshift-v2.sqlite'));
  const workspaces = new WorkspaceRepository(database);
  const tasks = new PlannerTaskRepository(database);
  const settings = new SettingsRepository(database);
  const runs = new RunRepository(database);
  const workers = new WorkerRepository(database);
  const processSupervisor = new WindowsProcessSupervisor();
  const fccRuntime = new FccRuntimeManager({ supervisor: processSupervisor });
  const fccGateway = new LocalFccGateway(fccRuntime);
  const availability = fccGateway.ensureAvailable();
  const claudeCode = new ClaudeCodeAdapter(processSupervisor, fccGateway);
  const codex = new CodexAdapter(processSupervisor, fccGateway);
  const agentRegistry = new AgentRegistry([claudeCode, codex]);
  runtime = {
    fccGateway,
    claudeCode,
    codex,
    agentRegistry,
    availability,
  };

  void availability.then((health) => {
    if (!health.available) {
      console.error(`[FCC] Runtime unavailable: ${health.failureReason ?? health.detail}`);
      return;
    }
    const ownership = health.ownedByNightShift ? 'NightShift-owned' : 'external';
    console.info(`[FCC] ${health.detail} (${ownership}, ${health.endpoint ?? 'no endpoint'}, ${health.version ?? 'unknown version'})`);
  }).catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[FCC] Runtime startup failed: ${detail}`);
  });

  const runService = new RunService(
    runs,
    tasks,
    workspaces,
    new GitWorktreeService(join(app.getPath('userData'), 'worktrees')),
    new Map<string, AgentAdapter>([['claude-code', runtime.claudeCode], ['codex', runtime.codex]]),
    { agentId: 'claude-code', modelId: 'nvidia_nim/nvidia/nemotron-3-super-120b-a12b', timeoutMs: 30 * 60_000 },
  );
  const workerService = new WorkerSessionService(
    workers,
    workspaces,
    new GitWorktreeService(join(app.getPath('userData'), 'worktrees')),
    new Map<string, AgentAdapter>([['claude-code', runtime.claudeCode], ['codex', runtime.codex]]),
  );

  registerIpcHandlers({
    appVersion: app.getVersion(),
    workspaces: new WorkspaceService(workspaces, settings),
    planner: new PlannerService(tasks, workspaces, runService),
    plannerSelectionCatalog: async () => {
      const activeRuntime = runtime;
      if (!activeRuntime) throw new Error('NightShift runtime is unavailable.');
      await activeRuntime.availability;
      await activeRuntime.agentRegistry.refresh();
      const catalog = activeRuntime.agentRegistry.plannerCatalog(await activeRuntime.fccGateway.listModels());
      return { ...catalog, defaultAgentId: 'claude-code', defaultModelId: 'nvidia_nim/nvidia/nemotron-3-super-120b-a12b' };
    },
    runs: runService,
    workers: workerService,
    workerSelectionCatalog: async () => {
      const activeRuntime = runtime;
      if (!activeRuntime) throw new Error('NightShift runtime is unavailable.');
      await activeRuntime.availability;
      await activeRuntime.agentRegistry.refresh();
      return activeRuntime.agentRegistry.workerCatalog(await activeRuntime.fccGateway.listModels());
    },
    launcher: new LauncherService(settings, workspaces),
  });
  runService.schedule();

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', (event) => {
  if (shutdownStarted) {
    return;
  }

  event.preventDefault();
  shutdownStarted = true;
  void shutdown().finally(() => app.quit());
});

const shutdown = async (): Promise<void> => {
  try {
    if (runtime) {
      await runtime.availability.catch(() => undefined);
      await runtime.fccGateway.stopOwnedProcess();
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[FCC] Failed to stop the NightShift-owned runtime: ${detail}`);
  } finally {
    runtime = undefined;
    database?.close();
    database = undefined;
  }
};
