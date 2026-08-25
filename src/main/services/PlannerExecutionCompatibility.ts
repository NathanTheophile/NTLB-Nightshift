import type { AgentAdapter } from './contracts/AgentAdapter';
import type { AgentCapabilities, PlannerExecutionMode } from '@shared/domain/entities';

export const executionModeRequirements: Readonly<Record<PlannerExecutionMode, readonly (keyof AgentCapabilities)[]>> = {
  single_agent: ['headless', 'structuredEvents', 'cancel', 'workingDirectory', 'modelOverride', 'plannerValidated'],
  sequential_batch: ['headless', 'structuredEvents', 'cancel', 'workingDirectory', 'modelOverride', 'plannerValidated'],
  delegated_leader: ['headless', 'structuredEvents', 'cancel', 'workingDirectory', 'modelOverride', 'delegatedValidated'],
};

export const satisfiesExecutionModeRequirements = (capabilities: AgentCapabilities, mode: PlannerExecutionMode): boolean =>
  executionModeRequirements[mode].every((capability) => capabilities[capability] === true);

export const supportsExecutionMode = (adapter: AgentAdapter, mode: PlannerExecutionMode): boolean =>
  satisfiesExecutionModeRequirements(adapter.capabilities(), mode) && adapter.supportsExecutionMode(mode);

export const supportsExecutionSelection = (adapter: AgentAdapter, mode: PlannerExecutionMode, modelId: string): boolean =>
  supportsExecutionMode(adapter, mode) && adapter.supportsModelForExecutionMode(mode, modelId);
