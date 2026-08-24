import type { Workspace } from './entities';

export interface OpenWorkspaceTabs {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
}

export const closeWorkspaceTab = (
  workspaces: readonly Workspace[],
  activeWorkspaceId: string | null,
  workspaceId: string,
): OpenWorkspaceTabs => {
  const closingIndex = workspaces.findIndex(({ id }) => id === workspaceId);
  if (closingIndex < 0) return { workspaces: [...workspaces], activeWorkspaceId };

  const remaining = workspaces.filter(({ id }) => id !== workspaceId);
  if (activeWorkspaceId !== workspaceId) return { workspaces: remaining, activeWorkspaceId };

  return {
    workspaces: remaining,
    activeWorkspaceId: remaining[closingIndex]?.id ?? remaining[closingIndex - 1]?.id ?? null,
  };
};

export const reorderWorkspaceTabs = (
  workspaces: readonly Workspace[],
  draggedWorkspaceId: string,
  targetWorkspaceId: string,
): Workspace[] => {
  const draggedIndex = workspaces.findIndex(({ id }) => id === draggedWorkspaceId);
  const targetIndex = workspaces.findIndex(({ id }) => id === targetWorkspaceId);
  if (draggedIndex < 0 || targetIndex < 0 || draggedIndex === targetIndex) return [...workspaces];

  const reordered = [...workspaces];
  const [draggedWorkspace] = reordered.splice(draggedIndex, 1);
  if (!draggedWorkspace) return reordered;
  reordered.splice(targetIndex, 0, draggedWorkspace);
  return reordered;
};
