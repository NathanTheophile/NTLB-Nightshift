import { describe, expect, it } from 'vitest';

import { closeWorkspaceTab, reorderWorkspaceTabs } from '../src/shared/domain/workspaceTabs';
import type { Workspace } from '../src/shared/domain/entities';

const workspace = (id: string): Workspace => ({
  id,
  rootPath: `C:\\projects\\${id}`,
  displayName: id,
  isGit: true,
  createdAt: '2026-08-24T00:00:00.000Z',
  lastOpenedAt: '2026-08-24T00:00:00.000Z',
});

const tabs = [workspace('alpha'), workspace('beta'), workspace('gamma')];

describe('workspace tab interactions', () => {
  it('selects the tab to the right when the active tab closes', () => {
    const result = closeWorkspaceTab(tabs, 'beta', 'beta');
    expect(result.workspaces.map(({ id }) => id)).toEqual(['alpha', 'gamma']);
    expect(result.activeWorkspaceId).toBe('gamma');
  });

  it('falls back to the tab on the left when the last active tab closes', () => {
    expect(closeWorkspaceTab(tabs, 'gamma', 'gamma').activeWorkspaceId).toBe('beta');
  });

  it('keeps the active tab when a background tab closes', () => {
    expect(closeWorkspaceTab(tabs, 'beta', 'alpha')).toMatchObject({ activeWorkspaceId: 'beta' });
  });

  it('reorders tabs without changing their identities', () => {
    expect(reorderWorkspaceTabs(tabs, 'alpha', 'gamma').map(({ id }) => id)).toEqual(['beta', 'gamma', 'alpha']);
    expect(reorderWorkspaceTabs(tabs, 'gamma', 'alpha').map(({ id }) => id)).toEqual(['gamma', 'alpha', 'beta']);
  });
});
