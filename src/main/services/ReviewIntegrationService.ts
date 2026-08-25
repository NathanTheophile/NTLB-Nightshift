import { mkdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RunIntegrationReview, ReviewerVerdict } from '@shared/domain/entities';
import type { AgentAdapter } from './contracts/AgentAdapter';
import { runGit, type GitCommand } from './GitWorktreeService';
import type { RunRepository } from '../persistence/repositories/RunRepository';
import type { WorkspaceRepository } from '../persistence/repositories/WorkspaceRepository';
import { RunIntegrationReviewRepository } from '../persistence/repositories/RunIntegrationReviewRepository';

export interface ReviewerRunner { review(input: { runId: string; workspaceId: string; candidateSha: string; targetDevSha: string; worktreePath: string; agentId: string; modelId: string; prompt: string }): Promise<string>; }
export interface IntegrationValidator { validate(path: string): Promise<{ passed: boolean; evidence: string }>; }
export class AdapterReviewerRunner implements ReviewerRunner {
  public constructor(private readonly adapters: ReadonlyMap<string, AgentAdapter>) {}
  public async review(input: Parameters<ReviewerRunner['review']>[0]): Promise<string> {
    const adapter = this.adapters.get(input.agentId); if (!adapter) throw new Error(`Reviewer agent ${input.agentId} is unavailable.`);
    const handle = await adapter.startRun({ runId: `review-${input.runId}-${randomUUID()}`, workspaceId: input.workspaceId, workingDirectory: input.worktreePath, modelId: input.modelId, prompt: input.prompt });
    const result = await handle.completion; if (!result.succeeded) throw new Error(result.failureReason ?? 'Reviewer failed.');
    return result.terminalEvent?.raw ?? '';
  }
}

export class ReviewIntegrationService {
  public constructor(private readonly runs: RunRepository, private readonly workspaces: WorkspaceRepository, private readonly reviews: RunIntegrationReviewRepository, private readonly reviewer: ReviewerRunner, private readonly storageRoot: string, private readonly validator: IntegrationValidator = new PackageScriptValidator(), private readonly git: GitCommand = runGit) {}

  public latest(runId: string): RunIntegrationReview | undefined { return this.reviews.latest(runId); }
  public async requestReview(runId: string): Promise<RunIntegrationReview> {
    const run = this.runs.findRequired(runId); this.assertReviewGate(run);
    const workspace = this.workspaces.findById(run.workspaceId); if (!workspace?.isGit) throw new Error('Review requires a Git workspace.');
    const candidateSha = await this.commit(workspace.rootPath, run.candidateCommitSha!); const targetDevSha = await this.commit(workspace.rootPath, 'dev');
    const reviewerPath = join(this.storageRoot, 'reviews', runId, randomUUID()); await mkdir(join(this.storageRoot, 'reviews', runId), { recursive: true });
    await this.mustGit(workspace.rootPath, ['worktree', 'add', '--detach', reviewerPath, candidateSha], 'Could not create reviewer worktree.');
    const source = await this.reviewer.review({ runId, workspaceId: run.workspaceId, candidateSha, targetDevSha, worktreePath: reviewerPath, agentId: run.resolvedAgentId, modelId: run.resolvedModelId, prompt: reviewerPrompt(candidateSha, targetDevSha) });
    const candidateAfter = await this.commit(workspace.rootPath, candidateSha); const devAfter = await this.commit(workspace.rootPath, 'dev');
    const parsed = parseVerdict(source);
    const verdict: ReviewerVerdict = candidateAfter !== candidateSha || devAfter !== targetDevSha ? 'NEEDS_ATTENTION' : parsed?.verdict ?? 'NEEDS_ATTENTION';
    const summary = candidateAfter !== candidateSha || devAfter !== targetDevSha ? 'Repository refs changed while the reviewer ran.' : parsed?.summary ?? 'Malformed reviewer verdict contract.';
    const findings = candidateAfter !== candidateSha || devAfter !== targetDevSha ? `candidate=${candidateAfter}; dev=${devAfter}` : parsed?.findings ?? source.slice(0, 16 * 1024);
    return this.reviews.create({ runId, candidateSha, targetDevSha, reviewerAgentId: run.resolvedAgentId, reviewerModelId: run.resolvedModelId, verdict, summary, findings });
  }
  public async integrate(reviewId: string): Promise<RunIntegrationReview> {
    const review = this.reviews.findRequired(reviewId); if (review.integrationStatus === 'integrated') return review;
    if (review.verdict !== 'PASS') return this.reviews.setIntegration(reviewId, 'rejected', { failureReason: 'Only a PASS review can be integrated.' });
    if (review.staleAt) return review;
    const run = this.runs.findRequired(review.runId); const workspace = this.workspaces.findById(run.workspaceId); if (!workspace?.isGit) return this.reviews.setIntegration(reviewId, 'rejected', { failureReason: 'Git workspace is unavailable.' });
    const currentCandidate = await this.commit(workspace.rootPath, run.candidateCommitSha ?? ''); const currentDev = await this.commit(workspace.rootPath, 'dev');
    const remoteCandidate = run.candidateBranchName ? await this.remoteSha(workspace.rootPath, run.candidateRemoteName ?? 'origin', run.candidateBranchName) : null;
    if (currentCandidate !== review.candidateSha || remoteCandidate !== review.candidateSha || currentDev !== review.targetDevSha) return this.reviews.markStale(reviewId, 'Candidate or dev no longer matches the reviewed SHA.');
    const remote = run.candidateRemoteName ?? 'origin'; const remoteDev = await this.remoteSha(workspace.rootPath, remote, 'dev');
    if (remoteDev !== review.targetDevSha) return this.reviews.markStale(reviewId, 'Remote dev moved since review.');
    this.reviews.setIntegration(reviewId, 'integrating');
    const integrationPath = join(this.storageRoot, 'integrations', reviewId); await mkdir(join(this.storageRoot, 'integrations'), { recursive: true });
    try {
      await this.mustGit(workspace.rootPath, ['worktree', 'add', '--detach', integrationPath, review.targetDevSha], 'Could not create integration worktree.');
      const merged = await this.git(integrationPath, ['merge', '--no-ff', '--no-edit', review.candidateSha]);
      if (merged.exitCode !== 0) return this.reviews.setIntegration(reviewId, 'needs_attention', { failureReason: `Merge conflict or failure: ${detail(merged)}` });
      const validation = await this.validator.validate(integrationPath);
      if (!validation.passed) return this.reviews.setIntegration(reviewId, 'needs_attention', { validation: validation.evidence, failureReason: 'Integrated-tree validation failed.' });
      const beforePush = await this.remoteSha(workspace.rootPath, remote, 'dev');
      if (beforePush !== review.targetDevSha) return this.reviews.markStale(reviewId, 'Remote dev moved before push.');
      const mergedSha = await this.commit(integrationPath, 'HEAD'); const pushed = await this.git(integrationPath, ['push', remote, `HEAD:refs/heads/dev`]);
      if (pushed.exitCode !== 0) return this.reviews.setIntegration(reviewId, 'needs_attention', { validation: validation.evidence, failureReason: `Push rejected: ${detail(pushed)}` });
      return this.reviews.setIntegration(reviewId, 'integrated', { commitSha: mergedSha, validation: validation.evidence });
    } catch (error) { return this.reviews.setIntegration(reviewId, 'needs_attention', { failureReason: error instanceof Error ? error.message : String(error) }); }
  }
  private assertReviewGate(run: ReturnType<RunRepository['findRequired']>): void { if (run.status !== 'completed' || run.candidatePublishState !== 'published' || !run.candidateCommitSha || run.validationStatus !== 'passed') throw new Error('Review requires a completed Run with a published candidate SHA and passed validation.'); }
  private async commit(path: string, ref: string): Promise<string> { const result = await this.git(path, ['rev-parse', '--verify', `${ref}^{commit}`]); if (result.exitCode !== 0) throw new Error(`Commit ${ref} is unavailable.`); return result.stdout.trim(); }
  private async remoteSha(path: string, remote: string, branch: string): Promise<string | null> { const result = await this.git(path, ['ls-remote', remote, `refs/heads/${branch}`]); if (result.exitCode !== 0) return null; return result.stdout.trim().split(/\s+/)[0] || null; }
  private async mustGit(path: string, args: string[], message: string): Promise<void> { const result = await this.git(path, args); if (result.exitCode !== 0) throw new Error(`${message} ${detail(result)}`); }
}

class PackageScriptValidator implements IntegrationValidator {
  public async validate(path: string): Promise<{ passed: boolean; evidence: string }> {
    try {
      const json = JSON.parse(await readFile(join(path, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
      const scripts = ['typecheck', 'lint', 'test', 'build'].filter((script) => typeof json.scripts?.[script] === 'string');
      if (!scripts.length) return { passed: false, evidence: 'No deterministic validation scripts are configured.' };
      const evidence: string[] = [];
      for (const script of scripts) { const result = await npmRun(path, script); evidence.push(`$ npm run ${script}\n${result.output}`); if (result.exitCode !== 0) return { passed: false, evidence: evidence.join('\n') }; }
      return { passed: true, evidence: evidence.join('\n') };
    } catch { return { passed: false, evidence: 'No package.json is available for deterministic validation.' }; }
  }
}
const npmRun = (cwd: string, script: string): Promise<{ exitCode: number | null; output: string }> => new Promise((resolve, reject) => { const child = spawn(process.platform === 'win32' ? 'cmd.exe' : 'npm', process.platform === 'win32' ? ['/d', '/s', '/c', `npm run ${script}`] : ['run', script], { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); let output = ''; child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8'); child.stdout.on('data', (chunk: string) => { output += chunk; }); child.stderr.on('data', (chunk: string) => { output += chunk; }); child.once('error', reject); child.once('close', (exitCode) => resolve({ exitCode, output: output.slice(0, 64 * 1024) })); });
const parseVerdict = (raw: string): { verdict: ReviewerVerdict; summary: string; findings: string } | undefined => { try { const value = JSON.parse(raw) as Record<string, unknown>; if ((value.verdict !== 'PASS' && value.verdict !== 'FAIL' && value.verdict !== 'NEEDS_ATTENTION') || typeof value.summary !== 'string' || typeof value.findings !== 'string') return undefined; return { verdict: value.verdict, summary: value.summary, findings: value.findings }; } catch { return undefined; } };
const reviewerPrompt = (candidateSha: string, targetDevSha: string): string => `You are a read-only code reviewer in a disposable detached worktree. Never edit files, commit, merge, reset, checkout branches, push, or mutate Git refs. Review candidate ${candidateSha} against dev ${targetDevSha}, including available validation evidence. Reply with exactly one JSON object and nothing else: {"verdict":"PASS|FAIL|NEEDS_ATTENTION","summary":"...","findings":"..."}.`;
const detail = (result: { stdout: string; stderr: string }): string => result.stderr.trim() || result.stdout.trim() || 'Git returned an error.';
