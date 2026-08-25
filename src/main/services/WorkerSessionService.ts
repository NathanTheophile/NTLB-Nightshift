import { randomUUID } from 'node:crypto';

import type { IsolationMode, WorkerConversation, WorkerEvent, WorkerPermissionProfile } from '@shared/domain/entities';

import type { WorkerRepository } from '../persistence/repositories/WorkerRepository';
import type { WorkspaceRepository } from '../persistence/repositories/WorkspaceRepository';
import { runGit } from './GitWorktreeService';
import type { AgentAdapter, AgentProtocolEvent } from './contracts/AgentAdapter';
import type { WorktreeService } from './contracts/WorktreeService';
import type { CreateWorkerConversationSpec, WorkerSessionService as WorkerSessionServiceContract } from './contracts/WorkerSessionService';

export type CreateWorkerInput = CreateWorkerConversationSpec;

export class WorkerSessionService implements WorkerSessionServiceContract {
  private readonly activeHandles = new Map<string, { adapter: AgentAdapter; handleId: string }>();

  public constructor(
    private readonly workers: WorkerRepository,
    private readonly workspaces: WorkspaceRepository,
    private readonly worktrees: WorktreeService,
    private readonly adapters: ReadonlyMap<string, AgentAdapter>,
    private readonly resolveGitHead: (repositoryRoot: string) => Promise<string | null> = async (repositoryRoot) => {
      const result = await runGit(repositoryRoot, ['rev-parse', '--verify', 'HEAD']);
      return result.exitCode === 0 ? result.stdout.trim() : null;
    },
  ) {}

  public create(spec: CreateWorkerInput): Promise<WorkerConversation> { return this.createConversation(spec); }

  public async createConversation(input: CreateWorkerInput): Promise<WorkerConversation> {
    validateConfiguration(input.permissionProfile, input.isolationMode);
    const workspace = this.workspaces.findById(input.workspaceId);
    if (!workspace) throw new Error('Worker workspace was not found.');
    const adapter = this.adapters.get(input.agentId);
    if (!adapter || !adapter.capabilities().workerValidated || !adapter.capabilities().structuredEvents) throw new Error('Selected Agent is not validated for structured Workers.');
    if (!input.modelId.trim()) throw new Error('A compatible FCC model is required.');

    const draftId = randomUUID();
    const scope = await this.resolveScope(workspace.rootPath, input.isolationMode, draftId);
    const worker = this.workers.create({ id: draftId, workspaceId: input.workspaceId, title: input.title.trim() || 'Claude Worker', agentId: input.agentId, modelId: input.modelId, permissionProfile: input.permissionProfile, isolationMode: input.isolationMode, workingDirectory: scope.workingDirectory, baseSha: scope.baseSha });
    this.workers.appendEvent(worker.id, 'system', null, { kind: 'worker_created', isolationMode: input.isolationMode, permissionProfile: input.permissionProfile, workingDirectory: scope.workingDirectory, baseSha: scope.baseSha });
    return worker;
  }

  public find(workerId: string): Promise<WorkerConversation | undefined> { return Promise.resolve(this.workers.find(workerId)); }
  public list(workspaceId: string): Promise<WorkerConversation[]> { return Promise.resolve(this.workers.list(workspaceId)); }
  public events(workerId: string): Promise<WorkerEvent[]> { this.workers.findRequired(workerId); return Promise.resolve(this.workers.listEvents(workerId)); }

  public async send(workerId: string, message: string): Promise<WorkerConversation> {
    const worker = this.workers.findRequired(workerId);
    if (worker.status === 'terminated') throw new Error('This Worker has been stopped. Create a new Worker to continue.');
    if (!message.trim()) throw new Error('Worker messages cannot be empty.');
    if (this.activeHandles.has(workerId)) throw new Error('Claude is still responding to this Worker.');
    const adapter = this.adapters.get(worker.agentId);
    if (!adapter) throw new Error('Worker Agent is no longer available.');
    this.workers.appendEvent(workerId, 'user', message.trim(), { role: 'user' });
    this.workers.setState(workerId, 'active');
    let handle;
    try {
      handle = await adapter.startWorker({ workerId, workspaceId: worker.workspaceId, workingDirectory: worker.workingDirectory, modelId: worker.modelId, permissionProfile: worker.permissionProfile, isolationMode: worker.isolationMode, prompt: message.trim(), externalSessionId: worker.externalSessionId, onProtocolEvent: (event) => this.persistProtocol(workerId, event) });
      this.activeHandles.set(workerId, { adapter, handleId: handle.handleId });
      const result = await handle.completion;
      this.activeHandles.delete(workerId);
      if (this.workers.findRequired(workerId).status !== 'terminated') {
        if (result.externalSessionId) this.workers.setState(workerId, result.succeeded ? 'waiting_for_user' : 'error', result.externalSessionId);
        else this.workers.setState(workerId, result.succeeded ? 'waiting_for_user' : 'error');
      }
      if (result.stderr) this.workers.appendEvent(workerId, 'stderr', result.stderr, { kind: 'stderr' });
      return this.workers.findRequired(workerId);
    } catch (error) {
      this.activeHandles.delete(workerId); this.workers.setState(workerId, 'error');
      this.workers.appendEvent(workerId, 'error', error instanceof Error ? error.message : String(error), { kind: 'worker_error' });
      throw error;
    }
  }

  public async terminate(workerId: string): Promise<WorkerConversation> {
    const active = this.activeHandles.get(workerId);
    if (active) await active.adapter.cancel(active.handleId);
    this.activeHandles.delete(workerId);
    this.workers.appendEvent(workerId, 'system', null, { kind: 'worker_terminated' });
    return this.workers.setState(workerId, 'terminated');
  }

  private async resolveScope(repositoryRoot: string, isolationMode: IsolationMode, workerId: string): Promise<{ workingDirectory: string; baseSha: string | null }> {
    if (isolationMode === 'direct_workspace') return { workingDirectory: repositoryRoot, baseSha: null };
    const baseSha = await this.resolveGitHead(repositoryRoot);
    if (!baseSha) throw new Error('Isolated Workers require a Git repository with a valid HEAD commit.');
    const handle = await this.worktrees.createForRun({ runId: workerId, repositoryRoot, baseSha });
    return { workingDirectory: handle.path, baseSha: handle.baseSha };
  }

  private persistProtocol(workerId: string, event: AgentProtocolEvent): void {
    const content = protocolContent(event.parsed);
    this.workers.appendEvent(workerId, event.type === 'assistant' ? 'assistant' : event.type ?? 'agent_protocol', content, event, event.timestamp);
  }
}

const validateConfiguration = (permission: WorkerPermissionProfile, isolation: IsolationMode): void => {
  if (permission === 'isolated_write' && isolation !== 'isolated_worktree') throw new Error('isolated_write requires isolated_worktree mode.');
  if (permission !== 'isolated_write' && isolation !== 'direct_workspace') throw new Error('Only isolated_write may create an isolated Worker worktree.');
};
const protocolContent = (parsed: unknown): string | null => {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const message = (parsed as { message?: { content?: unknown } }).message?.content;
  if (typeof message === 'string') return message;
  if (Array.isArray(message)) return message.map((item) => { if (!item || typeof item !== 'object' || !('text' in item)) return ''; const text = (item as { text?: unknown }).text; return typeof text === 'string' ? text : ''; }).filter(Boolean).join('\n') || null;
  const result = (parsed as { result?: unknown }).result; return typeof result === 'string' ? result : null;
};
