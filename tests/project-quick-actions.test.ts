import { describe, expect, it } from 'vitest';

import { projectQuickActionTools } from '../src/shared/domain/projectQuickActions';

describe('project Quick Actions', () => {
  it('keeps the complete project-level tool strip available in every section, including Runs', () => {
    expect(projectQuickActionTools).toEqual(['terminal', 'explorer', 'ide']);
  });
});
