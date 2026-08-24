import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, extname, isAbsolute, join } from 'node:path';

export interface ExecutableDiscoveryOptions {
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

/** Resolve one trusted executable name without involving a command shell. */
export const discoverExecutable = async (
  command: string,
  options: ExecutableDiscoveryOptions = {},
): Promise<string | null> => {
  const trimmedCommand = command.trim();
  if (!trimmedCommand) {
    throw new Error('Executable name must not be empty.');
  }

  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const directPath = isAbsolute(trimmedCommand) ? trimmedCommand : null;
  if (directPath) {
    if (platform === 'win32' && extname(directPath).toLowerCase() !== '.exe') {
      return null;
    }
    return (await isExecutableFile(directPath, platform)) ? directPath : null;
  }

  if (trimmedCommand.includes('/') || trimmedCommand.includes('\\')) {
    return null;
  }

  const pathValue = environmentValue(environment, 'PATH') ?? '';
  const pathDelimiter = platform === 'win32' ? ';' : delimiter;
  const extensions = executableExtensions(trimmedCommand, environment, platform);

  for (const rawDirectory of pathValue.split(pathDelimiter)) {
    const directory = rawDirectory.trim().replace(/^"|"$/g, '');
    if (!directory) {
      continue;
    }
    for (const extension of extensions) {
      const candidate = join(directory, `${trimmedCommand}${extension}`);
      if (await isExecutableFile(candidate, platform)) {
        return candidate;
      }
    }
  }

  return null;
};

const executableExtensions = (
  command: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): readonly string[] => {
  if (platform !== 'win32') {
    return [''];
  }
  if (extname(command)) {
    return [''];
  }

  const configured = environmentValue(environment, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD';
  const extensions = configured
    .split(';')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => (value.startsWith('.') ? value : `.${value}`));

  // FCC's uv launchers are native .exe shims. Batch files require a shell and
  // are intentionally excluded from this shell:false runtime boundary.
  return extensions.filter((value) => value.toLowerCase() === '.exe');
};

const isExecutableFile = async (candidate: string, platform: NodeJS.Platform): Promise<boolean> => {
  try {
    if (!(await stat(candidate)).isFile()) {
      return false;
    }
    if (platform !== 'win32') {
      await access(candidate, constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
};

const environmentValue = (environment: NodeJS.ProcessEnv, name: string): string | undefined => {
  const exact = environment[name];
  if (exact !== undefined) {
    return exact;
  }
  const matchingName = Object.keys(environment).find((key) => key.toLowerCase() === name.toLowerCase());
  return matchingName ? environment[matchingName] : undefined;
};
