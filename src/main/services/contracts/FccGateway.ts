import type { ModelDescriptor } from '@shared/domain/entities';

export type FccRuntimeState = 'unavailable' | 'starting' | 'healthy' | 'stopping' | 'failed';

export interface FccHealth {
  state: FccRuntimeState;
  available: boolean;
  endpoint: string | null;
  version: string | null;
  ownedByNightShift: boolean;
  detail: string;
  failureReason: string | null;
}

export interface FccGateway {
  detect(): Promise<FccHealth>;
  ensureAvailable(): Promise<FccHealth>;
  health(): Promise<FccHealth>;
  listModels(): Promise<readonly ModelDescriptor[]>;
  stopOwnedProcess(): Promise<void>;
}
