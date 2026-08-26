import type { AgentDescriptor, ModelDescriptor, PlannerExecutionMode } from '@shared/domain/entities';

import type { AgentAdapter, AgentRegistry as AgentRegistryContract } from './contracts/AgentAdapter';
import { supportsExecutionMode, supportsExecutionSelection } from './PlannerExecutionCompatibility';

export interface PlannerAgentCatalog {
  agents: readonly AgentDescriptor[];
  modelsByAgent: Readonly<Record<string, readonly ModelDescriptor[]>>;
}

export class AgentRegistry implements AgentRegistryContract {
  private detected: AgentDescriptor[] = [];
  public constructor(private readonly adapters: readonly AgentAdapter[]) {}
  public async refresh(): Promise<readonly AgentDescriptor[]> {
    const results = await Promise.all(this.adapters.map((adapter) => adapter.detect()));
    this.detected = results.filter((descriptor) => descriptor.installed && descriptor.launchable);
    return this.listDetected();
  }
  public listDetected(): readonly AgentDescriptor[] { return this.detected; }
  public findAdapter(agentId: string): AgentAdapter | undefined { return this.adapters.find((adapter) => adapter.id === agentId); }
  public plannerCatalog(models: readonly ModelDescriptor[]): PlannerAgentCatalog {
    return this.catalogForExecutionMode('single_agent', models);
  }
  public workerCatalog(models: readonly ModelDescriptor[]): PlannerAgentCatalog {
    const agents = this.detected.filter(({ capabilities }) => capabilities.interactive && capabilities.workerValidated && capabilities.structuredEvents);
    return { agents, modelsByAgent: Object.fromEntries(agents.map((agent) => [agent.id, models.filter((model) => this.supportsWorkerModel(agent.id, model.id))])) };
  }
  public catalogForExecutionMode(executionMode: PlannerExecutionMode, models: readonly ModelDescriptor[]): PlannerAgentCatalog {
    const agents = this.detected.filter((agent) => {
      const adapter = this.findAdapter(agent.id);
      return adapter !== undefined && supportsExecutionMode(adapter, executionMode);
    });
    return { agents, modelsByAgent: Object.fromEntries(agents.map((agent) => [agent.id, models.filter((model) => {
      const adapter = this.findAdapter(agent.id);
      return adapter !== undefined && supportsExecutionSelection(adapter, executionMode, model.id);
    })])) };
  }
  private supportsWorkerModel(agentId: string, modelId: string): boolean {
    const adapter = this.findAdapter(agentId) as (AgentAdapter & { supportsWorkerModel?: (value: string) => boolean }) | undefined;
    return adapter?.supportsWorkerModel?.(modelId) === true;
  }
}
