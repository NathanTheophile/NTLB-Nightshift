import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { FccGateway } from '../src/main/services/contracts/FccGateway';
import type {
  ProcessSupervisor,
  SupervisedProcessEventListener,
  SupervisedProcessResult,
  SupervisedProcessSnapshot,
  SupervisedProcessSpec,
} from '../src/main/services/contracts/ProcessSupervisor';
import { ClaudeCodeAdapter } from '../src/main/services/agents/ClaudeCodeAdapter';
import { buildClaudeRunArguments, buildClaudeWorkerArguments } from '../src/main/services/agents/claude/claudeCommand';
import { ClaudeStreamJsonParser } from '../src/main/services/agents/claude/ClaudeStreamJsonParser';

describe('ClaudeCodeAdapter runtime protocol', () => {
  it('constructs a bounded headless Planner command with allowlisted Bash validation and Git inspection', () => {
    const argumentsList = buildClaudeRunArguments({
      runId: 'run-1',
      workspaceId: 'workspace-1',
      workingDirectory: 'C:\\scratch\\probe',
      modelId: 'provider/model',
      prompt: 'Create the requested marker file.',
    });

    expect(argumentsList).toEqual([
      '-p',
      '--verbose',
      '--model',
      'provider/model',
      '--permission-mode',
      'acceptEdits',
      '--tools',
      'Read,Edit,Write,Glob,Grep,Bash',
      '--allowedTools',
      'Bash(npm run typecheck)',
      'Bash(npm run lint)',
      'Bash(npm test)',
      'Bash(npm test *)',
      'Bash(npm run build)',
      'Bash(npx vitest *)',
      'Bash(npm exec vitest *)',
      'Bash(git status)',
      'Bash(git status *)',
      'Bash(git diff)',
      'Bash(git diff *)',
      'Bash(git log)',
      'Bash(git log *)',
      'Bash(git show)',
      'Bash(git show *)',
      'Bash(git rev-parse)',
      'Bash(git rev-parse *)',
      '--output-format',
      'stream-json',
      'Create the requested marker file.',
    ]);
    expect(argumentsList).toEqual(expect.arrayContaining([
      'Read,Edit,Write,Glob,Grep,Bash', '--allowedTools', 'Bash(npm run typecheck)', 'Bash(npm run lint)', 'Bash(npm test *)', 'Bash(npm run build)', 'Bash(npx vitest *)', 'Bash(git status *)', 'Bash(git diff *)', 'Bash(git log *)', 'Bash(git show *)', 'Bash(git rev-parse *)',
    ]));
    expect(argumentsList).not.toContain('Bash');
    expect(argumentsList.join(' ')).not.toContain('dangerously-skip-permissions');
    for (const command of ['push', 'reset', 'clean', 'checkout', 'branch', 'worktree']) expect(argumentsList.join(' ')).not.toContain(`Bash(git ${command}`);
    expect(argumentsList).not.toContain('C:\\scratch\\probe');
  });

  it('incrementally preserves JSONL, extracts session id, result, and malformed lines', () => {
    const parser = new ClaudeStreamJsonParser();
    const first = parser.push('{"type":"system","session_id":"session-123"}\r');
    const second = parser.push('\n{"type":"assistant","session_id":"session-123","message":{"content":[]}}\nnot-json\n{"type":"res');
    const third = parser.push('ult","session_id":"session-123","result":"done"}\n');

    expect(first).toEqual([]);
    expect([...second, ...third]).toHaveLength(4);
    expect(second[0]).toMatchObject({ type: 'system', sessionId: 'session-123', parseError: null });
    expect(second[2]).toMatchObject({ rawLine: 'not-json', parsed: null, type: null });
    expect(third[0]).toMatchObject({ type: 'result', terminal: true, sessionId: 'session-123' });
    expect(parser.sessionId).toBe('session-123');
    expect(parser.terminalEvent?.rawLine).toContain('"type":"result"');
    expect(parser.finish()).toEqual([]);
  });

  it('maps Worker permissions to bounded Claude tools and resumes a validated session', () => {
    const readOnly = buildClaudeWorkerArguments({ workerId: 'worker-1', workspaceId: 'workspace-1', workingDirectory: 'C:\\repo', modelId: 'model', permissionProfile: 'read_only', isolationMode: 'direct_workspace', prompt: 'Inspect this project.', externalSessionId: null });
    const resumedWrite = buildClaudeWorkerArguments({ workerId: 'worker-1', workspaceId: 'workspace-1', workingDirectory: 'C:\\repo', modelId: 'model', permissionProfile: 'workspace_write', isolationMode: 'direct_workspace', prompt: 'Apply the fix.', externalSessionId: 'claude-session-1' });
    expect(readOnly).toContain('plan'); expect(readOnly).toContain('Read,Glob,Grep'); expect(readOnly.join(' ')).not.toContain('Edit');
    expect(resumedWrite).toContain('acceptEdits'); expect(resumedWrite).toContain('Read,Edit,Write,Glob,Grep'); expect(resumedWrite).toEqual(expect.arrayContaining(['--resume', 'claude-session-1'])); expect(resumedWrite.join(' ')).not.toContain('Bash');
  });

  it('starts a supervised headless run and preserves the external session', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'nightshift-claude-unit-'));
    try {
      const supervisor = new ScriptedSupervisor([
        '{"type":"system","session_id":"session-unit"}\n',
        '{"type":"result","session_id":"session-unit","subtype":"success","result":"done"}\n',
      ]);
      const adapter = new ClaudeCodeAdapter(supervisor, healthyGateway(), {
        discoverLauncher: () => Promise.resolve('C:\\tools\\fcc-claude.exe'),
        createExecutionId: () => 'claude-run-unit',
      });

      const handle = await adapter.startRun({
        runId: 'run-unit',
        workspaceId: 'workspace-unit',
        workingDirectory,
        modelId: 'provider/explicit-model',
        prompt: 'Edit one bounded file.',
      });
      const result = await handle.completion;

      expect(supervisor.startedSpec).toMatchObject({
        executionId: 'claude-run-unit',
        executablePath: 'C:\\tools\\fcc-claude.exe',
        workingDirectory,
      });
      expect(supervisor.startedSpec?.arguments).toContain('provider/explicit-model');
      expect(supervisor.startedSpec?.arguments).toEqual(expect.arrayContaining(['Read,Edit,Write,Glob,Grep,Bash', '--allowedTools', 'Bash(npm run typecheck)', 'Bash(git diff *)']));
      expect(supervisor.startedSpec?.arguments).not.toContain('Bash');
      expect(supervisor.startedSpec?.arguments.join(' ')).not.toContain('dangerously-skip-permissions');
      expect(handle.externalSessionId).toBe('session-unit');
      expect(result).toMatchObject({
        succeeded: true,
        exitCode: 0,
        externalSessionId: 'session-unit',
      });
      expect(result.events.map(({ raw }) => raw)).toEqual([
        '{"type":"system","session_id":"session-unit"}',
        '{"type":"result","session_id":"session-unit","subtype":"success","result":"done"}',
      ]);

      await adapter.cancel(handle.handleId);
      expect(supervisor.cancelledExecutionId).toBe(handle.handleId);
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });
});

class ScriptedSupervisor implements ProcessSupervisor {
  public startedSpec: SupervisedProcessSpec | null = null;
  public cancelledExecutionId: string | null = null;
  private listener: SupervisedProcessEventListener | null = null;

  public constructor(private readonly stdoutChunks: readonly string[]) {}

  public start(spec: SupervisedProcessSpec): Promise<SupervisedProcessSnapshot> {
    this.startedSpec = spec;
    return Promise.resolve(snapshot(spec.executionId));
  }

  public snapshot(executionId: string): SupervisedProcessSnapshot | undefined {
    return this.startedSpec?.executionId === executionId ? snapshot(executionId) : undefined;
  }

  public subscribe(executionId: string, listener: SupervisedProcessEventListener): () => void {
    this.listener = listener;
    for (const [sequence, chunk] of this.stdoutChunks.entries()) {
      listener({
        type: 'output',
        executionId,
        sequence,
        observedAt: '2026-08-25T00:00:00.000Z',
        stream: 'stdout',
        chunk,
      });
    }
    return () => {
      this.listener = null;
    };
  }

  public waitForCompletion(executionId: string): Promise<SupervisedProcessResult> {
    return Promise.resolve({
      ...snapshot(executionId),
      state: 'exited',
      finishedAt: '2026-08-25T00:00:01.000Z',
      exitCode: 0,
      signal: null,
      stdout: this.stdoutChunks.join(''),
      stderr: '',
    });
  }

  public cancelOwnedTree(executionId: string): Promise<void> {
    this.cancelledExecutionId = executionId;
    return Promise.resolve();
  }
}

const snapshot = (executionId: string): SupervisedProcessSnapshot => ({
  executionId,
  processId: 42,
  state: 'running',
  startedAt: '2026-08-25T00:00:00.000Z',
  lastOutputAt: null,
  finishedAt: null,
  cancellationRequested: false,
  exitCode: null,
  failureReason: null,
});

const healthyGateway = (): FccGateway => ({
  detect: () => Promise.resolve(healthyFcc()),
  ensureAvailable: () => Promise.resolve(healthyFcc()),
  health: () => Promise.resolve(healthyFcc()),
  listModels: () => Promise.resolve([]),
  stopOwnedProcess: () => Promise.resolve(),
});

const healthyFcc = () => ({
  state: 'healthy' as const,
  available: true,
  endpoint: 'http://127.0.0.1:8082',
  version: '5.14.2',
  ownedByNightShift: false,
  detail: 'healthy',
  failureReason: null,
});
