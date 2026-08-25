import type { AgentAdapter, AgentExecutionResult } from './contracts/AgentAdapter';
import type { PlannerTask, Run, RunStatus, ValidationStatus } from '@shared/domain/entities';
import type { RunRepository } from '../persistence/repositories/RunRepository';
import type { ProjectValidationService } from './ProjectValidationService';
import type { RunReviewService } from './RunReviewService';
import type { LeaderClient, LeaderDecision, LeaderRequest } from './DelegatedLeaderClient';

const MAX_ATTEMPTS = 4;
const cap = (value: string, bytes: number): { value: string; truncated: boolean } => Buffer.byteLength(value) <= bytes ? { value, truncated: false } : { value: Buffer.from(value).subarray(0, bytes).toString('utf8'), truncated: true };

export class DelegatedRunOrchestrator {
  public constructor(private readonly runs: RunRepository, private readonly validation: ProjectValidationService, private readonly reviews: RunReviewService, private readonly leader: LeaderClient) {}

  public async execute(spec: { run: Run; task: PlannerTask; worktreePath: string; adapter: AgentAdapter; deadline: number; isCancellationRequested: () => boolean; setActive: (cancel: () => Promise<void>) => void; clearActive: () => void }): Promise<RunStatus> {
    const { run, adapter } = spec;
    if (!adapter.capabilities().workerValidated || !adapter.supportsWorkerModel?.(run.resolvedModelId)) throw new Error(`Delegated Worker ${run.resolvedAgentId}/${run.resolvedModelId} is not validated.`);
    const luna = await this.leader.resolveLuna(); if (spec.isCancellationRequested()) return 'cancelled'; if (Date.now() >= spec.deadline) return 'timed_out'; this.runs.setDelegatedMetadata(run.id, luna.id, MAX_ATTEMPTS, 'planning'); this.runs.appendEvent(run.id, 'leader_resolution', { modelId: luna.id });
    let decision = await this.decide(spec, luna.id, 'initial', 0, null, 'not_configured');
    for (let index = 0; index < MAX_ATTEMPTS; index += 1) {
      if (spec.isCancellationRequested()) return 'cancelled'; if (Date.now() >= spec.deadline) return 'timed_out';
      if (decision.action === 'BLOCKED') return this.block(run.id, decision.blocker, decision.summary);
      if (decision.action === 'DONE') return this.block(run.id, 'leader_done_without_validation', 'Leader returned DONE before a passing validation.');
      const attempt = this.runs.createAttempt({ runId: run.id, attemptIndex: index, workerAgentId: run.resolvedAgentId, workerModelId: run.resolvedModelId, prompt: decision.instruction }); this.runs.appendEvent(run.id, 'attempt_created', { attemptId: attempt.id, index });
      this.runs.setAutonomyPhase(run.id, 'worker'); this.runs.setAttemptStatus(attempt.id, 'running', { started_at: new Date().toISOString() });
      const result = await this.worker(spec, attempt.id, decision.instruction);
      const cancelled = spec.isCancellationRequested(); if (cancelled) { this.runs.setAttemptStatus(attempt.id, 'cancelled', { finished_at: new Date().toISOString() }); return 'cancelled'; }
      if (Date.now() >= spec.deadline) { this.runs.setAttemptStatus(attempt.id, 'timed_out', { finished_at: new Date().toISOString() }); return 'timed_out'; }
      this.runs.setAttemptStatus(attempt.id, result.succeeded ? 'completed' : 'failed', { finished_at: new Date().toISOString(), external_session_id: result.externalSessionId, result_summary: result.terminalEvent?.raw ?? null, failure_reason: result.failureReason });
      this.runs.setAutonomyPhase(run.id, 'validation'); const validation = await this.validation.validate(run.id, spec.worktreePath, { attemptId: attempt.id, deadline: spec.deadline, isCancellationRequested: spec.isCancellationRequested, onProcessStarted: spec.setActive, onProcessFinished: spec.clearActive });
      this.runs.setAttemptStatus(attempt.id, this.runs.findAttemptRequired(attempt.id).status, { validation_status: validation });
      if (spec.isCancellationRequested()) return 'cancelled'; if (validation === 'interrupted') return Date.now() >= spec.deadline ? 'timed_out' : 'cancelled';
      this.runs.setAutonomyPhase(run.id, 'evaluating'); decision = await this.decide(spec, luna.id, 'post_attempt', index, result, validation);
      if (decision.action === 'DONE' && validation === 'passed') { this.runs.appendEvent(run.id, 'autonomous_completed', { summary: decision.summary }); return 'completed'; }
      if (decision.action === 'DONE') decision = await this.decide(spec, luna.id, 'post_attempt', index, result, validation, 'DONE is forbidden because validation did not pass. Return WORK or BLOCKED.');
      if (decision.action === 'BLOCKED') return this.block(run.id, decision.blocker, decision.summary);
    }
    return this.block(run.id, 'attempt_budget_exhausted', 'Delegated Leader attempt budget was exhausted.');
  }

  private async worker(spec: Parameters<DelegatedRunOrchestrator['execute']>[0], attemptId: string, prompt: string): Promise<AgentExecutionResult> {
    let handle: Awaited<ReturnType<AgentAdapter['startRun']>> | undefined; let cancellationRequested = false;
    const cancel = async (): Promise<void> => { cancellationRequested = true; if (handle) await spec.adapter.cancel(handle.handleId); };
    spec.setActive(cancel);
    try {
      handle = await spec.adapter.startRun({ runId: `${spec.run.id}:${attemptId}`, workspaceId: spec.run.workspaceId, workingDirectory: spec.worktreePath, modelId: spec.run.resolvedModelId, prompt, onProtocolEvent: (event) => this.runs.appendEvent(spec.run.id, 'agent_protocol', { attemptId, event }) });
      if (cancellationRequested || spec.isCancellationRequested() || Date.now() >= spec.deadline) await spec.adapter.cancel(handle.handleId);
      const timer = setTimeout(() => { void spec.adapter.cancel(handle!.handleId); }, Math.max(0, spec.deadline - Date.now()));
      try { return await handle.completion; } finally { clearTimeout(timer); }
    } finally { spec.clearActive(); }
  }

  private async decide(spec: Parameters<DelegatedRunOrchestrator['execute']>[0], modelId: string, phase: 'initial' | 'post_attempt', index: number, result: AgentExecutionResult | null, validation: ValidationStatus, invariant?: string): Promise<LeaderDecision> {
    if (spec.isCancellationRequested()) throw new Error('Run cancelled.'); if (Date.now() >= spec.deadline) throw new Error('Run timed out.');
    const review = await this.reviews.automationEvidence(spec.run.id); const diff = cap(review.patch, 80 * 1024); const commands = this.runs.validationCommands(spec.run.id).filter((item) => phase === 'initial' || item.attemptId === this.runs.attempts(spec.run.id).at(-1)?.id).map((item) => { const output = cap(item.output, 12 * 1024); return { command: item.command, status: item.status, exitCode: item.exitCode, output: output.value, outputTruncated: item.outputTruncated || output.truncated }; });
    const request: LeaderRequest = { protocolVersion: 1, runId: spec.run.id, phase, task: { title: cap(spec.task.title, 4 * 1024).value, prompt: cap(spec.task.prompt, 16 * 1024).value }, worker: { agentId: spec.run.resolvedAgentId, modelId: spec.run.resolvedModelId }, budget: { attemptIndex: index, maxAttempts: MAX_ATTEMPTS, remainingAttempts: phase === 'initial' ? MAX_ATTEMPTS : MAX_ATTEMPTS - index - 1 }, ...(result ? { attempt: { index, workerResultSummary: result.terminalEvent ? cap(result.terminalEvent.raw, 4 * 1024).value : null, workerFailureReason: result.failureReason ? cap(result.failureReason, 4 * 1024).value : null } } : {}), evidence: { gitStatus: cap(review.review.gitStatus, 8 * 1024).value, changedFiles: review.review.changedFiles.slice(0, 500).map((file) => file.path), diff: diff.value, diffTruncated: diff.truncated, validationStatus: validation, validationCommands: commands, priorAttemptSummaries: [...this.runs.attempts(spec.run.id).map((item) => cap(item.resultSummary ?? item.failureReason ?? '', 4 * 1024).value).filter(Boolean).slice(-4), ...(invariant ? [invariant] : [])] } };
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), Math.max(0, spec.deadline - Date.now())); spec.setActive(() => { controller.abort(); return Promise.resolve(); }); this.runs.appendEvent(spec.run.id, 'leader_request', { phase, attemptIndex: index });
    try { const decision = await this.leader.decide(modelId, request, controller.signal); this.runs.appendEvent(spec.run.id, 'leader_decision', decision); return decision; }
    catch (error) { this.runs.appendEvent(spec.run.id, 'leader_protocol_error', { detail: error instanceof Error ? error.message : String(error) }); throw error; }
    finally { clearTimeout(timer); spec.clearActive(); }
  }
  private block(runId: string, blocker: string, summary: string): 'blocked' { this.runs.setStatus(runId, 'running', { failure_reason: `${blocker}: ${summary}` }); this.runs.appendEvent(runId, 'autonomous_blocked', { blocker, summary }); return 'blocked'; }
}
