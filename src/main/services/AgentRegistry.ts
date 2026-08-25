import type { AgentDescriptor, ModelDescriptor } from '@shared/domain/entities';

import type { AgentAdapter, AgentRegistry as AgentRegistryContract } from './contracts/AgentAdapter';

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
    const agents = this.detected.filter(({ capabilities }) => capabilities.headless && capabilities.plannerValidated);
    return { agents, modelsByAgent: Object.fromEntries(agents.map((agent) => [agent.id, models.filter((model) => this.supportsPlannerModel(agent.id, model.id))])) };
  }
  private supportsPlannerModel(agentId: string, modelId: string): boolean {
    const adapter = this.findAdapter(agentId) as (AgentAdapter & { supportsPlannerModel?: (value: string) => boolean }) | undefined;
    return adapter?.supportsPlannerModel?.(modelId) === true;
  }
}
