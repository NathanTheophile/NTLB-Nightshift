import { describe, expect, it } from 'vitest';

import { createTerminalLaunchSpecs } from '../src/main/services/launcherSpecs';

describe('Windows terminal launcher specs', () => {
  it('roots Windows Terminal and the fixed fallback at the trusted workspace', () => {
    const workspaceRoot = 'C:\\projects\\nightshift & safe';
    const [windowsTerminal, fallback] = createTerminalLaunchSpecs(workspaceRoot, {
      SystemRoot: 'C:\\Windows',
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    });

    expect(windowsTerminal).toEqual({
      executable: 'wt.exe',
      argumentsList: ['-d', workspaceRoot],
      cwd: workspaceRoot,
    });
    expect(fallback).toEqual({
      executable: 'C:\\Windows\\System32\\cmd.exe',
      argumentsList: [
        '/d',
        '/c',
        'start',
        '""',
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        '-NoExit',
      ],
      cwd: workspaceRoot,
    });
    expect(fallback?.argumentsList).not.toContain(workspaceRoot);
  });
});
