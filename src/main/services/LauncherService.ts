import { stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { spawn } from 'node:child_process';

import { dialog, shell, type BrowserWindow } from 'electron';

import type {
  LauncherConfiguration,
  LaunchResult,
  WorkspaceTool,
} from '@shared/contracts/ipc';

import type { SettingsRepository } from '../persistence/repositories/SettingsRepository';
import type { WorkspaceRepository } from '../persistence/repositories/WorkspaceRepository';

interface IdeSetting {
  executablePath: string;
  displayName: string;
}

const ideSettingKey = 'launcher.ide';

export class LauncherService {
  public constructor(
    private readonly settings: SettingsRepository,
    private readonly workspaces: WorkspaceRepository,
  ) {}

  public getConfiguration(): LauncherConfiguration {
    const ide = this.settings.get<IdeSetting>(ideSettingKey);
    return {
      ideConfigured: Boolean(ide),
      ideDisplayName: ide?.displayName ?? null,
    };
  }

  public async configureIde(parentWindow: BrowserWindow): Promise<LauncherConfiguration> {
    const result = await dialog.showOpenDialog(parentWindow, {
      title: 'Configurer l’IDE NightShift',
      buttonLabel: 'Utiliser cet IDE',
      properties: ['openFile'],
      filters: [{ name: 'Applications Windows', extensions: ['exe'] }],
    });

    const executablePath = result.filePaths[0];
    if (result.canceled || !executablePath) {
      return this.getConfiguration();
    }

    await assertWindowsExecutable(executablePath);
    this.settings.set<IdeSetting>(ideSettingKey, {
      executablePath,
      displayName: basename(executablePath, extname(executablePath)),
    });
    return this.getConfiguration();
  }

  public async openWorkspaceTool(workspaceId: string, tool: WorkspaceTool): Promise<LaunchResult> {
    const workspace = this.workspaces.findById(workspaceId);
    if (!workspace) {
      throw new Error('A valid workspace is required to launch a project tool.');
    }

    if (tool === 'explorer') {
      const error = await shell.openPath(workspace.rootPath);
      if (error) {
        throw new Error(error);
      }
      return { status: 'launched', message: 'Workspace opened in Explorer.' };
    }

    if (process.platform !== 'win32') {
      throw new Error('NightShift project launchers currently target Windows.');
    }

    if (tool === 'terminal') {
      await launchDetached('powershell.exe', ['-NoExit'], workspace.rootPath);
      return { status: 'launched', message: 'Terminal opened at the workspace root.' };
    }

    const ide = this.settings.get<IdeSetting>(ideSettingKey);
    if (!ide) {
      return { status: 'configuration_required', message: 'Choose an IDE executable first.' };
    }

    await assertWindowsExecutable(ide.executablePath);
    await launchDetached(ide.executablePath, [workspace.rootPath], workspace.rootPath);
    return { status: 'launched', message: `Workspace opened in ${ide.displayName}.` };
  }
}

const launchDetached = async (executable: string, argumentsList: readonly string[], cwd: string): Promise<void> =>
  new Promise((resolveLaunch, rejectLaunch) => {
    const child = spawn(executable, argumentsList, {
      cwd,
      detached: true,
      shell: false,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.once('spawn', () => {
      child.unref();
      resolveLaunch();
    });
    child.once('error', rejectLaunch);
  });

const assertWindowsExecutable = async (executablePath: string): Promise<void> => {
  if (extname(executablePath).toLowerCase() !== '.exe') {
    throw new Error('The configured IDE must be a Windows executable.');
  }
  const executableStat = await stat(executablePath);
  if (!executableStat.isFile()) {
    throw new Error('The configured IDE executable no longer exists.');
  }
};
