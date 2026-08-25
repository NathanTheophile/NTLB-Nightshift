import { describe, expect, it } from 'vitest';

import { AgentRegistry } from '../src/main/services/AgentRegistry';
import type { AgentAdapter } from '../src/main/services/contracts/AgentAdapter';
import type { AgentCapabilities } from '../src/shared/domain/entities';

const capabilities: AgentCapabilities = { interactive: false, headless: true, structuredEvents: true, rawPty: false, resume: false, modelOverride: true, cancel: true, workingDirectory: true, imageInput: false, subagents: false, plannerValidated: true, workerValidated: false, renderMode: 'structured' };
const adapter = (id: string, launchable: boolean): AgentAdapter => ({ id, capabilities: () => capabilities, detect: () => Promise.resolve({ id, displayName: id, fccLauncher: `fcc-${id}`, installed: true, launchable, version: '5.14.2', capabilities, lastValidatedAt: null }), startRun: () => Promise.reject(new Error('unused')), startWorker: () => Promise.reject(new Error('unused')), cancel: () => Promise.resolve(), supportsPlannerModel: (model) => model === 'model' });

describe('AgentRegistry', () => {
  it('exposes only launchable detected adapters and explicit compatible models', async () => {
    const registry = new AgentRegistry([adapter('claude-code', true), adapter('codex', true), adapter('missing', false)]);
    await registry.refresh();
    expect(registry.listDetected().map(({ id }) => id)).toEqual(['claude-code', 'codex']);
    const catalog = registry.plannerCatalog([{ id: 'model', providerId: 'provider', displayName: 'Model', rawModelRef: 'provider/model', lastSeenAt: '2026-08-25T00:00:00.000Z' }, { id: 'other', providerId: 'provider', displayName: 'Other', rawModelRef: 'provider/other', lastSeenAt: '2026-08-25T00:00:00.000Z' }]);
    expect(catalog.modelsByAgent.codex?.map(({ id }) => id)).toEqual(['model']);
  });
});
