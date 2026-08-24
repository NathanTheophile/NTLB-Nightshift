import type { ModelDescriptor } from '@shared/domain/entities';

export interface FccHealth {
  available: boolean;
  endpoint: string | null;
  version: string | null;
  ownedByNightShift: boolean;
  detail: string;
}

export interface FccGateway {
  detect(): Promise<FccHealth>;
  health(): Promise<FccHealth>;
  listModels(): Promise<readonly ModelDescriptor[]>;
  stopOwnedProcess(): Promise<void>;
}
