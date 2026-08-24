import type { NightShiftApi } from '@shared/contracts/ipc';

declare global {
  interface Window {
    nightShift: NightShiftApi;
  }
}

export {};
