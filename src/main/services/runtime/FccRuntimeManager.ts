import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

import type { FccHealth, FccRuntimeState } from '../contracts/FccGateway';
import type { ProcessSupervisor, SupervisedProcessSnapshot } from '../contracts/ProcessSupervisor';
import { discoverExecutable } from './executableDiscovery';

const DEFAULT_ENDPOINT = 'http://127.0.0.1:8082';
const DEFAULT_REQUEST_TIMEOUT_MS = 1_500;
const DEFAULT_STARTUP_TIMEOUT_MS = 20_000;
const DEFAULT_POLL_INTERVAL_MS = 150;
const FCC_SERVER_EXECUTABLE = 'fcc-server';

export interface FccEndpointProbeResult {
  available: boolean;
  version: string | null;
  detail: string;
  failureReason: string | null;
}

export interface FccRuntimeProbe {
  probe(endpoint: string): Promise<FccEndpointProbeResult>;
}

export interface FccRuntimeManagerDependencies {
  supervisor: ProcessSupervisor;
  endpoint?: string;
  environment?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
  pollIntervalMs?: number;
  probe?: FccRuntimeProbe;
  discoverServer?: () => Promise<string | null>;
  probeVersion?: (executablePath: string) => Promise<string | null>;
  delay?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  createExecutionId?: () => string;
}

export class FccRuntimeManager {
  private readonly supervisor: ProcessSupervisor;
  private readonly endpoint: string;
  private readonly environment: Readonly<Record<string, string>>;
  private readonly startupTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly probe: FccRuntimeProbe;
  private readonly discoverServer: () => Promise<string | null>;
  private readonly probeVersion: (executablePath: string) => Promise<string | null>;
  private readonly delay: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  private readonly createExecutionId: () => string;

  private ownedExecutionId: string | null = null;
  private ensurePromise: Promise<FccHealth> | null = null;
  private currentHealth: FccHealth;

  public constructor(dependencies: FccRuntimeManagerDependencies) {
    this.supervisor = dependencies.supervisor;
    this.endpoint = normalizeLoopbackEndpoint(dependencies.endpoint ?? DEFAULT_ENDPOINT);
    const sourceEnvironment = dependencies.environment ?? process.env;
    this.environment = stringEnvironment(sourceEnvironment);
    this.startupTimeoutMs = positiveDuration(dependencies.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS);
    this.pollIntervalMs = positiveDuration(dependencies.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
    this.probe = dependencies.probe ?? new HttpFccRuntimeProbe();
    this.discoverServer = dependencies.discoverServer
      ?? (() => discoverExecutable(FCC_SERVER_EXECUTABLE, { environment: sourceEnvironment }));
    this.probeVersion = dependencies.probeVersion ?? probeFccVersion;
    this.delay = dependencies.delay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.now = dependencies.now ?? Date.now;
    this.createExecutionId = dependencies.createExecutionId ?? (() => `fcc-server-${randomUUID()}`);
    this.currentHealth = health('unavailable', this.endpoint, null, false, 'FCC has not been checked yet.', null);
  }

  public snapshot(): FccHealth {
    return { ...this.currentHealth };
  }

  public async detect(): Promise<FccHealth> {
    const result = await this.probe.probe(this.endpoint);
    const owned = this.reconcileOwnership();
    const state: FccRuntimeState = result.available ? 'healthy' : 'unavailable';
    this.currentHealth = health(
      state,
      this.endpoint,
      result.version ?? this.currentHealth.version,
      owned,
      result.detail,
      result.failureReason,
    );
    return this.snapshot();
  }

  public health(): Promise<FccHealth> {
    return this.detect();
  }

  public ensureAvailable(): Promise<FccHealth> {
    if (this.ensurePromise) {
      return this.ensurePromise;
    }

    const operation = this.ensureAvailableOnce();
    this.ensurePromise = operation;
    const clearOperation = () => {
      if (this.ensurePromise === operation) {
        this.ensurePromise = null;
      }
    };
    void operation.then(clearOperation, clearOperation);
    return operation;
  }

  public async stopOwnedProcess(): Promise<void> {
    const executionId = this.ownedExecutionId;
    if (!executionId) {
      return;
    }

    const snapshot = this.supervisor.snapshot(executionId);
    if (!isActiveProcess(snapshot)) {
      this.ownedExecutionId = null;
      this.currentHealth = health('unavailable', this.endpoint, this.currentHealth.version, false, 'Owned FCC server has already exited.', null);
      return;
    }

    this.currentHealth = health('stopping', this.endpoint, this.currentHealth.version, true, 'Stopping the NightShift-owned FCC server.', null);
    try {
      await this.supervisor.cancelOwnedTree(executionId);
      this.ownedExecutionId = null;
      this.currentHealth = health('unavailable', this.endpoint, this.currentHealth.version, false, 'NightShift-owned FCC server stopped.', null);
    } catch (error) {
      const message = errorMessage(error);
      this.currentHealth = health('failed', this.endpoint, this.currentHealth.version, true, 'Could not stop the NightShift-owned FCC server.', message);
      throw error;
    }
  }

  private async ensureAvailableOnce(): Promise<FccHealth> {
    const existing = await this.detect();
    if (existing.available) {
      return existing;
    }
    if (existing.ownedByNightShift) {
      return this.fail('The NightShift-owned FCC process is active but its health endpoint is unavailable.');
    }

    this.currentHealth = health('starting', this.endpoint, existing.version, false, 'Discovering the FCC server launcher.', null);
    const executablePath = await this.discoverServer();
    if (!executablePath) {
      return this.fail('FCC server launcher was not found on PATH.');
    }

    const launcherVersion = await this.probeVersion(executablePath).catch(() => null);
    const racedExternal = await this.detect();
    if (racedExternal.available) {
      return racedExternal;
    }

    const executionId = this.createExecutionId();
    this.currentHealth = health('starting', this.endpoint, launcherVersion, true, 'Starting the FCC server.', null);
    try {
      await this.supervisor.start({
        executionId,
        executablePath,
        arguments: [],
        workingDirectory: dirname(executablePath),
        environment: { ...this.environment, FCC_OPEN_BROWSER: 'false' },
      });
      this.ownedExecutionId = executionId;
    } catch (error) {
      return this.fail(`FCC server could not be started: ${errorMessage(error)}`, launcherVersion);
    }

    const deadline = this.now() + this.startupTimeoutMs;
    while (this.now() < deadline) {
      const endpointState = await this.probe.probe(this.endpoint);
      const processState = this.supervisor.snapshot(executionId);

      if (endpointState.available) {
        if (isActiveProcess(processState)) {
          this.currentHealth = health(
            'healthy',
            this.endpoint,
            endpointState.version ?? launcherVersion,
            true,
            'FCC server is healthy and owned by NightShift.',
            null,
          );
          return this.snapshot();
        }

        // Another FCC instance won the startup race. The process NightShift
        // launched is no longer active, so the healthy endpoint is external.
        this.ownedExecutionId = null;
        this.currentHealth = health(
          'healthy',
          this.endpoint,
          endpointState.version ?? launcherVersion,
          false,
          'Attached to an FCC server started outside NightShift.',
          null,
        );
        return this.snapshot();
      }

      if (!isActiveProcess(processState)) {
        this.ownedExecutionId = null;
        const result = await this.supervisor.waitForCompletion(executionId).catch(() => null);
        const stderr = boundedOutput(result?.stderr);
        const stderrDetail = stderr ? ` ${stderr}` : '';
        return this.fail(
          `FCC server exited before becoming ready${processState?.exitCode === null || processState?.exitCode === undefined ? '' : ` (exit ${processState.exitCode})`}.${stderrDetail}`,
          launcherVersion,
        );
      }

      await this.delay(this.pollIntervalMs);
    }

    await this.cancelStartupProcess(executionId);
    return this.fail(`FCC server did not become ready within ${this.startupTimeoutMs}ms.`, launcherVersion);
  }

  private reconcileOwnership(): boolean {
    const executionId = this.ownedExecutionId;
    if (!executionId) {
      return false;
    }
    const snapshot = this.supervisor.snapshot(executionId);
    if (!isActiveProcess(snapshot)) {
      this.ownedExecutionId = null;
      return false;
    }
    return true;
  }

  private async cancelStartupProcess(executionId: string): Promise<void> {
    const snapshot = this.supervisor.snapshot(executionId);
    if (isActiveProcess(snapshot)) {
      try {
        await this.supervisor.cancelOwnedTree(executionId);
      } catch {
        // Preserve the startup failure as the primary diagnostic. The
        // supervisor retains its own cancellation state for later inspection.
        return;
      }
    }
    if (!isActiveProcess(this.supervisor.snapshot(executionId))) {
      this.ownedExecutionId = null;
    }
  }

  private fail(message: string, version: string | null = this.currentHealth.version): FccHealth {
    this.currentHealth = health('failed', this.endpoint, version, this.reconcileOwnership(), message, message);
    return this.snapshot();
  }
}

export class HttpFccRuntimeProbe implements FccRuntimeProbe {
  public constructor(private readonly timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {}

  public async probe(endpoint: string): Promise<FccEndpointProbeResult> {
    try {
      const response = await fetch(new URL('/health', endpoint), {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) {
        return unavailable(`FCC health endpoint returned HTTP ${response.status}.`);
      }
      const payload: unknown = await response.json();
      if (!isRecord(payload) || payload.status !== 'healthy') {
        return unavailable('FCC health endpoint returned an unexpected response.');
      }

      const version = await this.readServerVersion(endpoint);
      return {
        available: true,
        version,
        detail: 'FCC health endpoint is reachable.',
        failureReason: null,
      };
    } catch (error) {
      return unavailable(`FCC health endpoint is unavailable: ${errorMessage(error)}`);
    }
  }

  private async readServerVersion(endpoint: string): Promise<string | null> {
    try {
      const response = await fetch(new URL('/openapi.json', endpoint), {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) {
        return null;
      }
      const payload: unknown = await response.json();
      if (!isRecord(payload) || !isRecord(payload.info) || typeof payload.info.version !== 'string') {
        return null;
      }
      return payload.info.version.trim() || null;
    } catch {
      return null;
    }
  }
}

export const probeFccVersion = async (executablePath: string): Promise<string | null> =>
  new Promise((resolve) => {
    const child = spawn(executablePath, ['--version'], {
      cwd: dirname(executablePath),
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    const timeout = setTimeout(() => {
      child.kill();
      resolve(null);
    }, 3_000);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.once('error', () => {
      clearTimeout(timeout);
      resolve(null);
    });
    child.once('close', (exitCode) => {
      clearTimeout(timeout);
      if (exitCode !== 0) {
        resolve(null);
        return;
      }
      resolve(stdout.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/)?.[0] ?? null);
    });
  });

const health = (
  state: FccRuntimeState,
  endpoint: string,
  version: string | null,
  ownedByNightShift: boolean,
  detail: string,
  failureReason: string | null,
): FccHealth => ({ state, available: state === 'healthy', endpoint, version, ownedByNightShift, detail, failureReason });

const unavailable = (message: string): FccEndpointProbeResult => ({
  available: false,
  version: null,
  detail: message,
  failureReason: message,
});

const normalizeLoopbackEndpoint = (value: string): string => {
  const endpoint = new URL(value);
  const hostname = endpoint.hostname.toLowerCase();
  if (endpoint.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(hostname)) {
    throw new Error('FCC endpoint must be an HTTP loopback address.');
  }
  if (endpoint.username || endpoint.password || (endpoint.pathname !== '/' && endpoint.pathname !== '')) {
    throw new Error('FCC endpoint must not contain credentials or a path.');
  }
  endpoint.pathname = '/';
  endpoint.search = '';
  endpoint.hash = '';
  return endpoint.toString().replace(/\/$/, '');
};

const stringEnvironment = (environment: NodeJS.ProcessEnv): Readonly<Record<string, string>> =>
  Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined));

const positiveDuration = (value: number | undefined, fallback: number): number => {
  const duration = value ?? fallback;
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('FCC runtime duration must be a positive number.');
  }
  return duration;
};

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isActiveProcess = (snapshot: SupervisedProcessSnapshot | undefined): boolean =>
  snapshot !== undefined && ['starting', 'running', 'cancelling'].includes(snapshot.state);

const boundedOutput = (value: string | undefined): string => {
  const normalized = value?.trim();
  if (!normalized) {
    return '';
  }
  return normalized.length <= 2_000 ? normalized : `…${normalized.slice(-1_999)}`;
};
