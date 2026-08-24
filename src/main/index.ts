import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { app, BrowserWindow } from 'electron';

import { registerIpcHandlers } from './ipc/registerIpcHandlers';
import { DatabaseService } from './persistence/DatabaseService';
import { PlannerTaskRepository } from './persistence/repositories/PlannerTaskRepository';
import { SettingsRepository } from './persistence/repositories/SettingsRepository';
import { WorkspaceRepository } from './persistence/repositories/WorkspaceRepository';
import { LauncherService } from './services/LauncherService';
import { PlannerService } from './services/PlannerService';
import { WorkspaceService } from './services/WorkspaceService';

const currentDirectory = fileURLToPath(new URL('.', import.meta.url));
let database: DatabaseService | undefined;

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

  registerIpcHandlers({
    appVersion: app.getVersion(),
    workspaces: new WorkspaceService(workspaces, settings),
    planner: new PlannerService(tasks, workspaces),
    launcher: new LauncherService(settings, workspaces),
  });

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

app.on('before-quit', () => {
  database?.close();
  database = undefined;
});
