import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';

import type { AgentCapabilities, AgentDescriptor } from '@shared/domain/entities';

import type {
  AgentAdapter,
  AgentExecutionHandle,
  AgentExecutionResult,
  AgentProtocolEvent,
  RunStartSpec,
  WorkerStartSpec,
} from '../contracts/AgentAdapter';
import type { FccGateway } from '../contracts/FccGateway';
import type { ProcessSupervisor, SupervisedProcessEvent, SupervisedProcessOutputEvent } from '../contracts/ProcessSupervisor';
import { discoverExecutable } from '../runtime/executableDiscovery';
import { buildClaudeRunArguments } from './claude/claudeCommand';
import { ClaudeStreamJsonParser, type ClaudeStreamEvent } from './claude/ClaudeStreamJsonParser';

const adapterId = 'claude-code';
const launcherCommand = 'fcc-claude';
const validatedPlannerModels = new Set(['nvidia_nim/nvidia/nemotron-3-super-120b-a12b']);

export interface ClaudeCodeAdapterOptions {
  environment?: NodeJS.ProcessEnv;
  discoverLauncher?: () => Promise<string | null>;
  now?: () => Date;
  createExecutionId?: (purpose: 'detect' | 'run', sourceId: string) => string;
}

export class ClaudeCodeAdapter implements AgentAdapter {
  public readonly id = adapterId;
  private readonly environment: Readonly<Record<string, string>>;
  private readonly discoverLauncher: () => Promise<string | null>;
  private readonly now: () => Date;
  private readonly createExecutionId: (purpose: 'detect' | 'run', sourceId: string) => string;

  public constructor(
    private readonly supervisor: ProcessSupervisor,
    private readonly gateway: FccGateway,
    options: ClaudeCodeAdapterOptions = {},
  ) {
    const sourceEnvironment = options.environment ?? process.env;
    this.environment = stringEnvironment(sourceEnvironment);
    this.discoverLauncher = options.discoverLauncher
      ?? (() => discoverExecutable(launcherCommand, { environment: sourceEnvironment }));
    this.now = options.now ?? (() => new Date());
    this.createExecutionId = options.createExecutionId
      ?? ((purpose, sourceId) => `claude-${purpose}-${sourceId}-${randomUUID()}`);
  }

  public capabilities(): AgentCapabilities {
    return {
      interactive: false,
      headless: true,
      structuredEvents: true,
      rawPty: false,
      resume: false,
      modelOverride: true,
      cancel: true,
      workingDirectory: true,
      imageInput: false,
      subagents: false,
      plannerValidated: true,
      workerValidated: false,
      renderMode: 'structured',
    };
  }

  public supportsPlannerModel(modelId: string): boolean {
    return validatedPlannerModels.has(modelId);
  }

  public async detect(): Promise<AgentDescriptor> {
    const executablePath = await this.discoverLauncher();
    if (!executablePath) return this.descriptor(launcherCommand, false, false, null, null);

    const runtime = await this.gateway.detect();
    if (!runtime.available) return this.descriptor(executablePath, true, false, null, null);

    const executionId = this.createExecutionId('detect', randomUUID());
    try {
      await this.supervisor.start({
        executionId,
        executablePath,
        arguments: ['--version'],
        workingDirectory: process.cwd(),
        environment: this.environment,
      });
      const result = await this.supervisor.waitForCompletion(executionId);
      const version = result.exitCode === 0 ? parseClaudeVersion(result.stdout) : null;
      return this.descriptor(executablePath, true, result.exitCode === 0, version, result.exitCode === 0 ? this.now().toISOString() : null);
    } catch {
      return this.descriptor(executablePath, true, false, null, null);
    }
  }

  public async startRun(spec: RunStartSpec): Promise<AgentExecutionHandle> {
    const runtime = await this.gateway.ensureAvailable();
    if (!runtime.available) throw new Error(runtime.failureReason ?? 'FCC is unavailable.');

    const executablePath = await this.discoverLauncher();
    if (!executablePath) throw new Error('fcc-claude was not found on PATH.');
    const directory = await stat(spec.workingDirectory);
    if (!directory.isDirectory()) throw new Error('Claude working directory must be an existing directory.');

    const handleId = this.createExecutionId('run', spec.runId);
    await this.supervisor.start({
      executionId: handleId,
      executablePath,
      arguments: buildClaudeRunArguments(spec),
      workingDirectory: spec.workingDirectory,
      environment: this.environment,
    });

    const parser = new ClaudeStreamJsonParser();
    const protocolEvents: AgentProtocolEvent[] = [];
    const handleReference: { current?: AgentExecutionHandle } = {};
    const append = (event: ClaudeStreamEvent, timestamp: string): void => {
      protocolEvents.push({
        sequence: protocolEvents.length,
        timestamp,
        raw: event.rawLine,
        parsed: event.parsed,
        type: event.type,
        externalSessionId: event.sessionId,
        terminal: event.terminal,
        parseError: event.parseError,
      });
      if (parser.sessionId && handleReference.current) {
        handleReference.current.externalSessionId = parser.sessionId;
      }
      spec.onProtocolEvent?.(protocolEvents[protocolEvents.length - 1]!);
    };
    const unsubscribe = this.supervisor.subscribe(handleId, (event) => {
      if (isStdout(event)) {
        for (const parsedEvent of parser.push(event.chunk)) append(parsedEvent, event.observedAt);
      }
    });
    const completion = this.supervisor.waitForCompletion(handleId).then((processResult): AgentExecutionResult => {
      for (const parsedEvent of parser.finish()) append(parsedEvent, processResult.finishedAt ?? this.now().toISOString());
      unsubscribe();
      const terminalEvent = [...protocolEvents].reverse().find(({ terminal }) => terminal) ?? null;
      const failureReason = executionFailure(processResult.exitCode, terminalEvent);
      return {
        handleId,
        succeeded: failureReason === null,
        failureReason,
        exitCode: processResult.exitCode,
        signal: processResult.signal,
        externalSessionId: parser.sessionId,
        events: protocolEvents,
        terminalEvent,
        stderr: processResult.stderr,
      };
    });
    const executionHandle: AgentExecutionHandle = {
      handleId,
      externalSessionId: null,
      events: protocolEvents,
      completion,
    };
    handleReference.current = executionHandle;
    if (parser.sessionId) executionHandle.externalSessionId = parser.sessionId;
    return executionHandle;
  }

  public startWorker(spec: WorkerStartSpec): Promise<AgentExecutionHandle> {
    void spec;
    return Promise.reject(new Error('Claude Worker sessions are not implemented in this runtime milestone.'));
  }

  public cancel(handleId: string): Promise<void> {
    return this.supervisor.cancelOwnedTree(handleId);
  }

  private descriptor(
    launcher: string,
    installed: boolean,
    launchable: boolean,
    version: string | null,
    lastValidatedAt: string | null,
  ): AgentDescriptor {
    return {
      id: this.id,
      displayName: 'Claude Code',
      fccLauncher: launcher,
      installed,
      launchable,
      version,
      capabilities: this.capabilities(),
      lastValidatedAt,
    };
  }
}

const isStdout = (event: SupervisedProcessEvent): event is SupervisedProcessOutputEvent =>
  event.type === 'output' && event.stream === 'stdout';

const parseClaudeVersion = (stdout: string): string | null =>
  stdout.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/u)?.[0] ?? null;

const executionFailure = (exitCode: number | null, terminalEvent: AgentProtocolEvent | null): string | null => {
  if (exitCode !== 0) return `Claude exited with code ${String(exitCode)}.`;
  if (!terminalEvent) return 'Claude exited without emitting a terminal result event.';
  if (isErrorResult(terminalEvent.parsed)) return 'Claude reported an unsuccessful terminal result.';
  return null;
};

const isErrorResult = (value: unknown): boolean => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return result.is_error === true || result.subtype === 'error';
};

const stringEnvironment = (environment: NodeJS.ProcessEnv): Readonly<Record<string, string>> =>
  Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined));
