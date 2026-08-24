import { access, readdir, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { dialog, type BrowserWindow } from 'electron';

import type {
  ListWorkspaceEntriesRequest,
  WorkspaceDirectoryPage,
  WorkspaceEntry,
  WorkspaceTabState,
} from '@shared/contracts/ipc';
import type { Workspace } from '@shared/domain/entities';

import type { WorkspaceRepository } from '../persistence/repositories/WorkspaceRepository';
import type { SettingsRepository } from '../persistence/repositories/SettingsRepository';

const workspaceTabStateKey = 'workspace.tabs';

export class WorkspaceService {
  public constructor(
    private readonly workspaces: WorkspaceRepository,
    private readonly settings: SettingsRepository,
  ) {}

  public getOpenTabs(): { workspaces: Workspace[]; activeWorkspaceId: string | null } {
    const knownWorkspaces = this.workspaces.list();
    const savedState = this.settings.get<WorkspaceTabState>(workspaceTabStateKey);
    if (!savedState) {
      return {
        workspaces: knownWorkspaces,
        activeWorkspaceId: knownWorkspaces[0]?.id ?? null,
      };
    }

    const workspacesById = new Map(knownWorkspaces.map((workspace) => [workspace.id, workspace]));
    const openWorkspaces = savedState.workspaceIds.flatMap((workspaceId) => {
      const workspace = workspacesById.get(workspaceId);
      return workspace ? [workspace] : [];
    });
    const activeWorkspaceId = openWorkspaces.some(({ id }) => id === savedState.activeWorkspaceId)
      ? savedState.activeWorkspaceId
      : openWorkspaces[0]?.id ?? null;
    return { workspaces: openWorkspaces, activeWorkspaceId };
  }

  public saveTabState(state: WorkspaceTabState): void {
    const uniqueIds = new Set(state.workspaceIds);
    if (uniqueIds.size !== state.workspaceIds.length) {
      throw new Error('Open workspace tabs must be unique.');
    }
    for (const workspaceId of state.workspaceIds) {
      this.findRequired(workspaceId);
    }
    if (state.activeWorkspaceId !== null && !uniqueIds.has(state.activeWorkspaceId)) {
      throw new Error('The active workspace must be one of the open tabs.');
    }
    this.settings.set(workspaceTabStateKey, state);
  }

  public findRequired(workspaceId: string): Workspace {
    const workspace = this.workspaces.findById(workspaceId);
    if (!workspace) {
      throw new Error('The selected workspace no longer exists.');
    }
    return workspace;
  }

  public async select(parentWindow: BrowserWindow): Promise<Workspace | null> {
    const result = await dialog.showOpenDialog(parentWindow, {
      title: 'Ouvrir un projet NightShift',
      buttonLabel: 'Ouvrir le projet',
      properties: ['openDirectory', 'createDirectory'],
    });

    const selectedPath = result.filePaths[0];
    if (result.canceled || !selectedPath) {
      return null;
    }

    const canonicalPath = await realpath(selectedPath);
    const selectedStat = await stat(canonicalPath);
    if (!selectedStat.isDirectory()) {
      throw new Error('The selected workspace must be a directory.');
    }

    return this.workspaces.addOrTouch(
      canonicalPath,
      basename(canonicalPath),
      await this.isGitWorkspace(canonicalPath),
    );
  }

  public async listEntries(request: ListWorkspaceEntriesRequest): Promise<WorkspaceDirectoryPage> {
    const workspace = this.findRequired(request.workspaceId);
    const directoryPath = await this.resolveExistingPath(workspace.rootPath, request.relativePath);
    const directoryStat = await stat(directoryPath);
    if (!directoryStat.isDirectory()) {
      throw new Error('Only workspace directories can be listed.');
    }

    const directoryEntries = await readdir(directoryPath, { withFileTypes: true });
    const sortedEntries = directoryEntries.sort((left, right) => {
      const leftRank = left.isDirectory() ? 0 : left.isSymbolicLink() ? 2 : 1;
      const rightRank = right.isDirectory() ? 0 : right.isSymbolicLink() ? 2 : 1;
      return leftRank - rightRank || left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
    });

    const pageEntries = sortedEntries.slice(request.offset, request.offset + request.limit);
    const entries: WorkspaceEntry[] = pageEntries.map((entry) => ({
      name: entry.name,
      relativePath: toPortableRelativePath(workspace.rootPath, join(directoryPath, entry.name)),
      kind: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : 'file',
    }));
    const nextOffset = request.offset + pageEntries.length;

    return {
      entries,
      nextOffset: nextOffset < sortedEntries.length ? nextOffset : null,
    };
  }

  private async resolveExistingPath(rootPath: string, requestedRelativePath: string): Promise<string> {
    if (isAbsolute(requestedRelativePath)) {
      throw new Error('Workspace paths must be relative.');
    }

    const candidate = resolve(rootPath, requestedRelativePath);
    assertPathWithin(rootPath, candidate);

    const [canonicalRoot, canonicalCandidate] = await Promise.all([realpath(rootPath), realpath(candidate)]);
    assertPathWithin(canonicalRoot, canonicalCandidate);
    return canonicalCandidate;
  }

  private async isGitWorkspace(rootPath: string): Promise<boolean> {
    try {
      await access(join(rootPath, '.git'));
      return true;
    } catch {
      return false;
    }
  }
}

const assertPathWithin = (rootPath: string, candidatePath: string): void => {
  const pathFromRoot = relative(rootPath, candidatePath);
  if (pathFromRoot === '' || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..' && !isAbsolute(pathFromRoot))) {
    return;
  }
  throw new Error('The requested path is outside the selected workspace.');
};

const toPortableRelativePath = (rootPath: string, candidatePath: string): string =>
  relative(rootPath, candidatePath).split(sep).join('/');
