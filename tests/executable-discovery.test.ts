import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { discoverExecutable } from '../src/main/services/runtime/executableDiscovery';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('executable discovery', () => {
  it('discovers an FCC executable through Windows PATH and PATHEXT', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nightshift-discovery-'));
    temporaryDirectories.push(directory);
    const executablePath = join(directory, 'fcc-server.exe');
    await writeFile(executablePath, 'fixture');

    const discovered = await discoverExecutable('fcc-server', {
      platform: 'win32',
      environment: { Path: directory, PATHEXT: '.CMD;.EXE' },
    });
    expect(discovered?.toLowerCase()).toBe(executablePath.toLowerCase());
  });

  it('does not accept batch launchers that would require a shell', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nightshift-discovery-'));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, 'fcc-server.cmd'), '@echo off');

    await expect(discoverExecutable('fcc-server', {
      platform: 'win32',
      environment: { PATH: directory, PATHEXT: '.CMD' },
    })).resolves.toBeNull();
  });
});
