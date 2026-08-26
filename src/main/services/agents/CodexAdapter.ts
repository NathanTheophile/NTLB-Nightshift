import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';

import type { AgentCapabilities, AgentDescriptor, PlannerExecutionMode } from '@shared/domain/entities';

import type { AgentAdapter, AgentExecutionHandle, AgentExecutionResult, AgentProtocolEvent, RunStartSpec, WorkerStartSpec } from '../contracts/AgentAdapter';
import type { FccGateway } from '../contracts/FccGateway';
import type { ProcessSupervisor, SupervisedProcessEvent, SupervisedProcessOutputEvent } from '../contracts/ProcessSupervisor';
import { discoverExecutable } from '../runtime/executableDiscovery';
import { buildCodexRunArguments } from './codex/codexCommand';
import { CodexJsonlParser, type CodexJsonlEvent } from './codex/CodexJsonlParser';
import { satisfiesExecutionModeRequirements } from '../PlannerExecutionCompatibility';

const adapterId = 'codex';
const launcherCommand = 'fcc-codex';
const validatedRunModels = new Set(['nvidia_nim/nvidia/nemotron-3-super-120b-a12b']);

export interface CodexAdapterOptions {
  environment?: NodeJS.ProcessEnv;
  discoverLauncher?: () => Promise<string | null>;
  now?: () => Date;
  createExecutionId?: (purpose: 'detect' | 'run', sourceId: string) => string;
}

export class CodexAdapter implements AgentAdapter {
  public readonly id = adapterId;
  private readonly environment: Readonly<Record<string, string>>;
  private readonly discoverLauncher: () => Promise<string | null>;
  private readonly now: () => Date;
  private readonly createExecutionId: (purpose: 'detect' | 'run', sourceId: string) => string;

  public constructor(private readonly supervisor: ProcessSupervisor, private readonly gateway: FccGateway, options: CodexAdapterOptions = {}) {
    const sourceEnvironment = options.environment ?? process.env;
    this.environment = stringEnvironment(sourceEnvironment);
    this.discoverLauncher = options.discoverLauncher ?? (() => discoverExecutable(launcherCommand, { environment: sourceEnvironment }));
    this.now = options.now ?? (() => new Date());
    this.createExecutionId = options.createExecutionId ?? ((purpose, sourceId) => `codex-${purpose}-${sourceId}-${randomUUID()}`);
  }

  public capabilities(): AgentCapabilities {
    return { interactive: false, headless: true, structuredEvents: true, rawPty: false, resume: false, modelOverride: true, cancel: true, workingDirectory: true, imageInput: false, subagents: false, plannerValidated: true, delegatedValidated: true, workerValidated: false, renderMode: 'structured' };
  }

  public supportsPlannerModel(modelId: string): boolean { return validatedRunModels.has(modelId); }
  public supportsExecutionMode(executionMode: PlannerExecutionMode): boolean { return satisfiesExecutionModeRequirements(this.capabilities(), executionMode); }
  public supportsModelForExecutionMode(executionMode: PlannerExecutionMode, modelId: string): boolean {
    void executionMode;
    return validatedRunModels.has(modelId);
  }

  public async detect(): Promise<AgentDescriptor> {
    const executablePath = await this.discoverLauncher();
    if (!executablePath) return this.descriptor(launcherCommand, false, false, null, null);
    const runtime = await this.gateway.detect();
    if (!runtime.available) return this.descriptor(executablePath, true, false, null, null);
    const executionId = this.createExecutionId('detect', randomUUID());
    try {
      await this.supervisor.start({ executionId, executablePath, arguments: ['--version'], workingDirectory: process.cwd(), environment: this.environment });
      const result = await this.supervisor.waitForCompletion(executionId);
      const version = result.exitCode === 0 ? parseVersion(result.stdout) : null;
      return this.descriptor(executablePath, true, result.exitCode === 0, version, result.exitCode === 0 ? this.now().toISOString() : null);
    } catch { return this.descriptor(executablePath, true, false, null, null); }
  }

  public async startRun(spec: RunStartSpec): Promise<AgentExecutionHandle> {
    const runtime = await this.gateway.ensureAvailable();
    if (!runtime.available) throw new Error(runtime.failureReason ?? 'FCC is unavailable.');
    if (!validatedRunModels.has(spec.modelId)) throw new Error(`Codex coding model is not validated: ${spec.modelId}`);
    const executablePath = await this.discoverLauncher();
    if (!executablePath) throw new Error('fcc-codex was not found on PATH.');
    if (!(await stat(spec.workingDirectory)).isDirectory()) throw new Error('Codex working directory must be an existing directory.');
    const handleId = this.createExecutionId('run', spec.runId);
    await this.supervisor.start({ executionId: handleId, executablePath, arguments: buildCodexRunArguments(spec), workingDirectory: spec.workingDirectory, environment: this.environment });

    const parser = new CodexJsonlParser();
    const events: AgentProtocolEvent[] = [];
    const handleReference: { current?: AgentExecutionHandle } = {};
    const append = (event: CodexJsonlEvent, timestamp: string): void => {
      events.push({ sequence: events.length, timestamp, raw: event.rawLine, parsed: event.parsed, type: event.type, externalSessionId: event.threadId, terminal: event.terminal, parseError: event.parseError });
      if (parser.threadId && handleReference.current) handleReference.current.externalSessionId = parser.threadId;
      spec.onProtocolEvent?.(events[events.length - 1]!);
    };
    const unsubscribe = this.supervisor.subscribe(handleId, (event) => { if (isStdout(event)) for (const parsed of parser.push(event.chunk)) append(parsed, event.observedAt); });
    const completion = this.supervisor.waitForCompletion(handleId).then((processResult): AgentExecutionResult => {
      for (const event of parser.finish()) append(event, processResult.finishedAt ?? this.now().toISOString());
      unsubscribe();
      const terminalEvent = [...events].reverse().find(({ terminal }) => terminal) ?? null;
      const failureReason = completionFailure(processResult.exitCode, terminalEvent);
      return { handleId, succeeded: failureReason === null, failureReason, exitCode: processResult.exitCode, signal: processResult.signal, externalSessionId: parser.threadId, events, terminalEvent, stderr: processResult.stderr };
    });
    const handle: AgentExecutionHandle = { handleId, externalSessionId: null, events, completion };
    handleReference.current = handle;
    return handle;
  }

  public startWorker(spec: WorkerStartSpec): Promise<AgentExecutionHandle> { void spec; return Promise.reject(new Error('Codex Worker sessions are not implemented in this runtime milestone.')); }
  public cancel(handleId: string): Promise<void> { return this.supervisor.cancelOwnedTree(handleId); }
  private descriptor(launcher: string, installed: boolean, launchable: boolean, version: string | null, lastValidatedAt: string | null): AgentDescriptor { return { id: this.id, displayName: 'Codex', fccLauncher: launcher, installed, launchable, version, capabilities: this.capabilities(), lastValidatedAt }; }
}

const isStdout = (event: SupervisedProcessEvent): event is SupervisedProcessOutputEvent => event.type === 'output' && event.stream === 'stdout';
const parseVersion = (stdout: string): string | null => stdout.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/u)?.[0] ?? null;
const completionFailure = (exitCode: number | null, terminalEvent: AgentProtocolEvent | null): string | null => {
  if (exitCode !== 0) return `Codex exited with code ${String(exitCode)}.`;
  if (!terminalEvent) return 'Codex exited without emitting a turn.completed event.';
  return null;
};
const stringEnvironment = (environment: NodeJS.ProcessEnv): Readonly<Record<string, string>> => Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined));
