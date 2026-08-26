import { describe, expect, it } from 'vitest';

import { AgentRegistry } from '../src/main/services/AgentRegistry';
import { ClaudeCodeAdapter } from '../src/main/services/agents/ClaudeCodeAdapter';
import { CodexAdapter } from '../src/main/services/agents/CodexAdapter';
import type { AgentAdapter } from '../src/main/services/contracts/AgentAdapter';
import type { FccGateway } from '../src/main/services/contracts/FccGateway';
import type { ProcessSupervisor } from '../src/main/services/contracts/ProcessSupervisor';
import type { AgentCapabilities } from '../src/shared/domain/entities';

const capabilities: AgentCapabilities = { interactive: false, headless: true, structuredEvents: true, rawPty: false, resume: false, modelOverride: true, cancel: true, workingDirectory: true, imageInput: false, subagents: false, plannerValidated: true, delegatedValidated: true, workerValidated: false, renderMode: 'structured' };
const adapter = (id: string, launchable: boolean): AgentAdapter => ({ id, capabilities: () => capabilities, detect: () => Promise.resolve({ id, displayName: id, fccLauncher: `fcc-${id}`, installed: true, launchable, version: '5.14.2', capabilities, lastValidatedAt: null }), startRun: () => Promise.reject(new Error('unused')), startWorker: () => Promise.reject(new Error('unused')), cancel: () => Promise.resolve(), supportsExecutionMode: () => true, supportsModelForExecutionMode: (_mode, model) => model === 'model', supportsPlannerModel: (model) => model === 'model' });

describe('AgentRegistry', () => {
  it('exposes only launchable detected adapters and explicit compatible models', async () => {
    const registry = new AgentRegistry([adapter('claude-code', true), adapter('codex', true), adapter('missing', false)]);
    await registry.refresh();
    expect(registry.listDetected().map(({ id }) => id)).toEqual(['claude-code', 'codex']);
    const catalog = registry.plannerCatalog([{ id: 'model', providerId: 'provider', displayName: 'Model', rawModelRef: 'provider/model', lastSeenAt: '2026-08-25T00:00:00.000Z' }, { id: 'other', providerId: 'provider', displayName: 'Other', rawModelRef: 'provider/other', lastSeenAt: '2026-08-25T00:00:00.000Z' }]);
    expect(catalog.modelsByAgent.codex?.map(({ id }) => id)).toEqual(['model']);
  });

  it('exposes only explicitly validated Worker model combinations', async () => {
    const workerCapabilities: AgentCapabilities = { ...capabilities, interactive: true, workerValidated: true };
    const worker: AgentAdapter = { ...adapter('claude-code', true), capabilities: () => workerCapabilities, detect: () => Promise.resolve({ id: 'claude-code', displayName: 'Claude Code', fccLauncher: 'fcc-claude', installed: true, launchable: true, version: 'test', capabilities: workerCapabilities, lastValidatedAt: null }), supportsWorkerModel: (model) => model === 'model' };
    const registry = new AgentRegistry([worker]); await registry.refresh();
    const catalog = registry.workerCatalog([{ id: 'model', providerId: 'provider', displayName: 'Model', rawModelRef: 'provider/model', lastSeenAt: '2026-08-25T00:00:00.000Z' }, { id: 'other', providerId: 'provider', displayName: 'Other', rawModelRef: 'provider/other', lastSeenAt: '2026-08-25T00:00:00.000Z' }]);
    expect(catalog.modelsByAgent['claude-code']?.map(({ id }) => id)).toEqual(['model']);
  });

  it('derives execution compatibility without mode-specific model ownership', async () => {
    const codex = new CodexAdapter(noopSupervisor, healthyGateway, { discoverLauncher: () => Promise.resolve('fcc-codex') });
    const registry = new AgentRegistry([new ClaudeCodeAdapter(noopSupervisor, healthyGateway, { discoverLauncher: () => Promise.resolve('fcc-claude') }), codex]);
    await registry.refresh();
    const models = [model('nvidia_nim/nvidia/nemotron-3-super-120b-a12b'), model('openai/gpt-5.6-luna'), model('openai/gpt-5.6')];

    const single = registry.catalogForExecutionMode('single_agent', models);
    expect(single.agents.map(({ id }) => id)).toEqual(['claude-code', 'codex']);
    expect(single.modelsByAgent['claude-code']?.map(({ id }) => id))
      .toEqual(['nvidia_nim/nvidia/nemotron-3-super-120b-a12b', 'openai/gpt-5.6-luna']);
    expect(single.modelsByAgent.codex?.map(({ id }) => id))
      .toEqual(['nvidia_nim/nvidia/nemotron-3-super-120b-a12b']);

    const sequential = registry.catalogForExecutionMode('sequential_batch', models);
    expect(sequential.agents.map(({ id }) => id)).toEqual(['claude-code', 'codex']);
    expect(sequential.modelsByAgent['claude-code']?.map(({ id }) => id))
      .toEqual(['nvidia_nim/nvidia/nemotron-3-super-120b-a12b', 'openai/gpt-5.6-luna']);
    expect(sequential.modelsByAgent.codex?.map(({ id }) => id))
      .toEqual(['nvidia_nim/nvidia/nemotron-3-super-120b-a12b']);

    const delegated = registry.catalogForExecutionMode('delegated_leader', models);
    expect(delegated.agents.map(({ id }) => id)).toEqual(['claude-code', 'codex']);
    expect(codex.capabilities().interactive).toBe(false);
    expect(delegated.modelsByAgent['claude-code']?.map(({ id }) => id))
      .toEqual(['nvidia_nim/nvidia/nemotron-3-super-120b-a12b', 'openai/gpt-5.6-luna']);
    expect(delegated.modelsByAgent.codex?.map(({ id }) => id))
      .toEqual(['nvidia_nim/nvidia/nemotron-3-super-120b-a12b']);
  });
});

const model = (id: string) => ({ id, providerId: id.split('/', 1)[0]!, displayName: id, rawModelRef: id, lastSeenAt: '2026-08-25T00:00:00.000Z' });
const healthyGateway: FccGateway = { detect: () => Promise.resolve({ state: 'healthy', available: true, endpoint: 'http://127.0.0.1', version: '5.14.2', ownedByNightShift: false, detail: 'healthy', failureReason: null }), ensureAvailable: () => Promise.resolve({ state: 'healthy', available: true, endpoint: 'http://127.0.0.1', version: '5.14.2', ownedByNightShift: false, detail: 'healthy', failureReason: null }), health: () => Promise.resolve({ state: 'healthy', available: true, endpoint: 'http://127.0.0.1', version: '5.14.2', ownedByNightShift: false, detail: 'healthy', failureReason: null }), listModels: () => Promise.resolve([]), stopOwnedProcess: () => Promise.resolve() };
const noopSupervisor: ProcessSupervisor = { start: (spec) => Promise.resolve({ executionId: spec.executionId, processId: 1, state: 'running', startedAt: '2026-08-25T00:00:00.000Z', lastOutputAt: null, finishedAt: null, cancellationRequested: false, exitCode: null, failureReason: null }), snapshot: () => undefined, subscribe: () => () => undefined, waitForCompletion: (executionId) => Promise.resolve({ executionId, processId: 1, state: 'exited', startedAt: '2026-08-25T00:00:00.000Z', lastOutputAt: null, finishedAt: '2026-08-25T00:00:00.000Z', cancellationRequested: false, exitCode: 0, signal: null, stdout: '2.0.0', stderr: '', failureReason: null }), cancelOwnedTree: () => Promise.resolve() };
