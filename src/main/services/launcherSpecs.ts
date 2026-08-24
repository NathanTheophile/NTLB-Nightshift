import { join } from 'node:path';

export interface DetachedLaunchSpec {
  executable: string;
  argumentsList: readonly string[];
  cwd: string;
}

export const createTerminalLaunchSpecs = (
  workspaceRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): readonly DetachedLaunchSpec[] => {
  const windowsDirectory = environment.SystemRoot ?? environment.WINDIR ?? 'C:\\Windows';
  const commandProcessor = environment.ComSpec ?? join(windowsDirectory, 'System32', 'cmd.exe');
  const powershell = join(windowsDirectory, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

  return [
    {
      executable: 'wt.exe',
      argumentsList: ['-d', workspaceRoot],
      cwd: workspaceRoot,
    },
    {
      executable: commandProcessor,
      argumentsList: ['/d', '/c', 'start', '""', powershell, '-NoExit'],
      cwd: workspaceRoot,
    },
  ];
};
