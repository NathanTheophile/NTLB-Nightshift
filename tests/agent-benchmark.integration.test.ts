import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import type { AgentAdapter } from '../src/main/services/contracts/AgentAdapter';
import { WindowsProcessSupervisor } from '../src/main/services/WindowsProcessSupervisor';
import { ClaudeCodeAdapter } from '../src/main/services/agents/ClaudeCodeAdapter';
import { CodexAdapter } from '../src/main/services/agents/CodexAdapter';
import { FccRuntimeManager } from '../src/main/services/runtime/FccRuntimeManager';
import { LocalFccGateway } from '../src/main/services/runtime/LocalFccGateway';

const exec = promisify(execFile);
const benchmarkEnabled = process.env.NIGHTSHIFT_RUN_FCC_BENCHMARK === '1';
const model = 'nvidia_nim/nvidia/nemotron-3-super-120b-a12b';
const timeoutMs = 180_000;
const prompt = 'Create NIGHTSHIFT_BENCHMARK_MARKER.txt in the repository root. Its complete contents must be exactly NIGHTSHIFT_BENCHMARK_OK. Do not modify any other file. Then report completion.';

describe.skipIf(!benchmarkEnabled)('same-model Claude Code vs Codex benchmark', () => {
  it('records the same bounded task evidence for both adapters', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nightshift-agent-benchmark-'));
    const source = join(root, 'source');
    const supervisor = new WindowsProcessSupervisor();
    const gateway = new LocalFccGateway(new FccRuntimeManager({ supervisor }));
    try {
      await exec('git', ['init', source]); await exec('git', ['-C', source, 'config', 'user.email', 'benchmark@nightshift.local']); await exec('git', ['-C', source, 'config', 'user.name', 'NightShift Benchmark']);
      await writeFile(join(source, 'README.md'), 'benchmark base\n'); await exec('git', ['-C', source, 'add', '.']); await exec('git', ['-C', source, 'commit', '-m', 'base']);
      const results = [];
      for (const [name, adapter] of [['Claude Code', new ClaudeCodeAdapter(supervisor, gateway)], ['Codex', new CodexAdapter(supervisor, gateway)]] as const) {
        const workingDirectory = join(root, adapter.id);
        await exec('git', ['clone', '--no-local', source, workingDirectory]);
        const started = performance.now();
        const handle = await adapter.startRun({ runId: `benchmark-${adapter.id}`, workspaceId: 'benchmark', workingDirectory, modelId: model, prompt });
        const result = await within(adapter, handle.handleId, handle.completion);
        const marker = await readFile(join(workingDirectory, 'NIGHTSHIFT_BENCHMARK_MARKER.txt'), 'utf8').catch(() => null);
        const { stdout: status } = await exec('git', ['status', '--short'], { cwd: workingDirectory });
        results.push({ agent: name, success: result.succeeded && marker === 'NIGHTSHIFT_BENCHMARK_OK', wallMs: Math.round(performance.now() - started), exitCode: result.exitCode, externalSessionId: result.externalSessionId, structuredEvents: result.events.length > 0, stderr: result.stderr || null, filesChanged: status.trim() || null, finalGitState: status.trim() || 'clean' });
      }
      console.table(results);
      expect(results).toHaveLength(2);
      expect(results.every(({ success, structuredEvents }) => success && structuredEvents)).toBe(true);
    } finally { await gateway.stopOwnedProcess(); await rm(root, { recursive: true, force: true }); }
  }, timeoutMs * 2 + 60_000);
});

const within = async <T>(adapter: AgentAdapter, handleId: string, completion: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([completion, new Promise<never>((_, reject) => { timer = setTimeout(() => { void adapter.cancel(handleId).finally(() => reject(new Error(`Benchmark timed out after ${timeoutMs}ms.`))); }, timeoutMs); })]); }
  finally { if (timer) clearTimeout(timer); }
};
