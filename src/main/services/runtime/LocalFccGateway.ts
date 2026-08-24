import type { ModelDescriptor } from '@shared/domain/entities';

import type { FccGateway, FccHealth } from '../contracts/FccGateway';
import type { FccRuntimeManager } from './FccRuntimeManager';

const DEFAULT_REQUEST_TIMEOUT_MS = 3_000;

interface FccModelPayload {
  id: string;
  displayName: string;
  providerModelRef: string;
}

export interface LocalFccGatewayOptions {
  fetchModels?: (endpoint: string) => Promise<unknown>;
  now?: () => Date;
}

export class LocalFccGateway implements FccGateway {
  private readonly fetchModels: (endpoint: string) => Promise<unknown>;
  private readonly now: () => Date;

  public constructor(
    private readonly runtime: FccRuntimeManager,
    options: LocalFccGatewayOptions = {},
  ) {
    this.fetchModels = options.fetchModels ?? fetchModelCatalog;
    this.now = options.now ?? (() => new Date());
  }

  public detect(): Promise<FccHealth> {
    return this.runtime.detect();
  }

  public ensureAvailable(): Promise<FccHealth> {
    return this.runtime.ensureAvailable();
  }

  public health(): Promise<FccHealth> {
    return this.runtime.health();
  }

  public async listModels(): Promise<readonly ModelDescriptor[]> {
    const runtimeHealth = await this.runtime.health();
    if (!runtimeHealth.available || !runtimeHealth.endpoint) {
      throw new Error(runtimeHealth.failureReason ?? 'FCC is unavailable.');
    }

    const payload = await this.fetchModels(runtimeHealth.endpoint);
    const models = parseModelCatalog(payload);
    const lastSeenAt = this.now().toISOString();
    return models.map((model) => ({
      id: model.id,
      providerId: model.providerModelRef.split('/', 1)[0] ?? 'unknown',
      displayName: model.displayName,
      rawModelRef: model.providerModelRef,
      lastSeenAt,
    }));
  }

  public stopOwnedProcess(): Promise<void> {
    return this.runtime.stopOwnedProcess();
  }
}

export const parseModelCatalog = (payload: unknown): readonly FccModelPayload[] => {
  if (!isRecord(payload) || payload.object !== 'list' || !Array.isArray(payload.data)) {
    throw new Error('FCC returned an invalid model catalog.');
  }

  return payload.data.map((entry) => {
    if (!isRecord(entry) || typeof entry.id !== 'string' || !entry.id.trim()) {
      throw new Error('FCC model catalog contains an invalid model identifier.');
    }
    const providerModelRef = typeof entry.provider_model_ref === 'string' && entry.provider_model_ref.trim()
      ? entry.provider_model_ref
      : entry.id;
    const displayName = typeof entry.display_name === 'string' && entry.display_name.trim()
      ? entry.display_name
      : providerModelRef;
    return { id: entry.id, displayName, providerModelRef };
  });
};

const fetchModelCatalog = async (endpoint: string): Promise<unknown> => {
  const url = new URL('/v1/models', endpoint);
  url.searchParams.set('view', 'messages');
  const response = await fetch(url, {
    method: 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const authHint = response.status === 401 || response.status === 403
      ? ' FCC proxy authentication is enabled and is not configured in NightShift.'
      : '';
    throw new Error(`FCC model catalog returned HTTP ${response.status}.${authHint}`);
  }
  return response.json();
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
