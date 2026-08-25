import type { RunStatus } from './entities';

export const canCancelRun = (status: RunStatus): boolean => status === 'preparing' || status === 'running';
export const normalizeFollowUpPrompt = (prompt: string): string | null => prompt.trim() || null;
