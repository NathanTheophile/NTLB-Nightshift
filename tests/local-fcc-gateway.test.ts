import { describe, expect, it, vi } from 'vitest';

import type { ProcessSupervisor } from '../src/main/services/contracts/ProcessSupervisor';
import { FccRuntimeManager, type FccRuntimeProbe } from '../src/main/services/runtime/FccRuntimeManager';
import { LocalFccGateway, parseModelCatalog } from '../src/main/services/runtime/LocalFccGateway';

const noProcessSupervisor: ProcessSupervisor = {
  start: vi.fn(),
  snapshot: vi.fn(),
  subscribe: vi.fn(() => () => undefined),
  waitForCompletion: vi.fn(),
  cancelOwnedTree: vi.fn(),
};

describe('LocalFccGateway', () => {
  it('maps FCC messages-view models without fabricating model data', async () => {
    const runtime = healthyRuntime();
    const gateway = new LocalFccGateway(runtime, {
      now: () => new Date('2026-08-25T12:00:00.000Z'),
      fetchModels: () => Promise.resolve({
        object: 'list',
        data: [{
          id: 'nvidia_nim/nvidia/nemotron-3-super-120b-a12b',
          display_name: 'Nemotron Super',
          provider_model_ref: 'nvidia_nim/nvidia/nemotron-3-super-120b-a12b',
        }],
      }),
    });

    await expect(gateway.listModels()).resolves.toEqual([{
      id: 'nvidia_nim/nvidia/nemotron-3-super-120b-a12b',
      providerId: 'nvidia_nim',
      displayName: 'Nemotron Super',
      rawModelRef: 'nvidia_nim/nvidia/nemotron-3-super-120b-a12b',
      lastSeenAt: '2026-08-25T12:00:00.000Z',
    }]);
  });

  it('rejects malformed catalogs instead of inventing fallback entries', () => {
    expect(() => parseModelCatalog({ object: 'list', data: [{ display_name: 'missing id' }] }))
      .toThrow('invalid model identifier');
  });

  it('does not request models while FCC is unavailable', async () => {
    const fetchModels = vi.fn();
    const runtime = new FccRuntimeManager({
      supervisor: noProcessSupervisor,
      probe: { probe: () => Promise.resolve({ available: false, version: null, detail: 'offline', failureReason: 'offline' }) },
    });
    const gateway = new LocalFccGateway(runtime, { fetchModels });

    await expect(gateway.listModels()).rejects.toThrow('offline');
    expect(fetchModels).not.toHaveBeenCalled();
  });
});

const healthyRuntime = (): FccRuntimeManager => {
  const probe: FccRuntimeProbe = {
    probe: () => Promise.resolve({ available: true, version: '5.14.2', detail: 'healthy', failureReason: null }),
  };
  return new FccRuntimeManager({ supervisor: noProcessSupervisor, probe });
};
