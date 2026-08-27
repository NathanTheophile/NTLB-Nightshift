import { execFile } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { DatabaseService } from '../src/main/persistence/DatabaseService';
import { PlannerTaskRepository } from '../src/main/persistence/repositories/PlannerTaskRepository';
import { RunIntegrationReviewRepository } from '../src/main/persistence/repositories/RunIntegrationReviewRepository';
import { RunRepository } from '../src/main/persistence/repositories/RunRepository';
import { SettingsRepository } from '../src/main/persistence/repositories/SettingsRepository';
import { WorkspaceRepository } from '../src/main/persistence/repositories/WorkspaceRepository';
import { runGit, type GitCommand } from '../src/main/services/GitWorktreeService';
import { ReviewIntegrationService, SupervisedIntegrationValidator, candidateProgressionKey, devBaseKey, resolveEffectiveDevBase, type IntegrationValidator, type ReviewerRunner } from '../src/main/services/ReviewIntegrationService';
import type { ProcessSupervisor, SupervisedProcessResult, SupervisedProcessSnapshot } from '../src/main/services/contracts/ProcessSupervisor';

const exec = promisify(execFile);

describe.concurrent('ReviewIntegrationService review evidence', () => {
  it('removes the temporary reviewer worktree after recording the verdict', async () => {
    const fixture = await setup({ remote: false });
    try {
      await fixture.service.requestReview((await fixture.publishedCandidate('cleanup-review')).id);
      expect(await exists(fixture.reviewer.inputs[0]!.worktreePath)).toBe(false);
    } finally { await fixture.dispose(); }
  });
  it.each([['PASS'], ['FAIL']] as const)('persists a valid %s reviewer verdict', async (verdict) => {
    const fixture = await setup({ remote: false });
    try {
      const run = await fixture.publishedCandidate('change');
      fixture.reviewer.raw = JSON.stringify({ verdict, summary: `${verdict} summary`, findings: 'finding' });
      const review = await fixture.service.requestReview(run.id);
      expect(review).toMatchObject({ verdict, summary: `${verdict} summary`, findings: 'finding', integrationStatus: 'not_started' });
    } finally { await fixture.dispose(); }
  });

  it('downgrades malformed reviewer output and reviewer failures to NEEDS_ATTENTION', async () => {
    const fixture = await setup({ remote: false });
    try {
      const malformed = await fixture.publishedCandidate('malformed');
      fixture.reviewer.raw = 'not a verdict';
      expect((await fixture.service.requestReview(malformed.id)).verdict).toBe('NEEDS_ATTENTION');

      const timeout = await fixture.publishedCandidate('timeout');
      fixture.reviewer.error = new Error('Reviewer exceeded the hard timeout.');
      const review = await fixture.service.requestReview(timeout.id);
      expect(review).toMatchObject({ verdict: 'NEEDS_ATTENTION', summary: 'Reviewer exceeded the hard timeout.' });
    } finally { await fixture.dispose(); }
  });

  it('never passes a reviewer that mutates its isolated worktree', async () => {
    const fixture = await setup({ remote: false });
    try {
      const run = await fixture.publishedCandidate('mutation');
      fixture.reviewer.mutate = true;
      const review = await fixture.service.requestReview(run.id);
      expect(review).toMatchObject({ verdict: 'NEEDS_ATTENTION', summary: 'Reviewer or repository mutation detected.' });
    } finally { await fixture.dispose(); }
  });

  it('bounds candidate patch evidence to 512 KiB and records truncation', async () => {
    const fixture = await setup({ remote: false });
    try {
      const run = await fixture.publishedCandidate('large', 'x'.repeat(600 * 1024));
      await fixture.service.requestReview(run.id);
      const evidence = fixture.reviewer.inputs[0]!.evidence as { candidatePatch: string; patchTruncated: boolean };
      expect(Buffer.byteLength(evidence.candidatePatch)).toBeLessThanOrEqual(512 * 1024);
      expect(evidence.patchTruncated).toBe(true);
    } finally { await fixture.dispose(); }
  });
});

describe('ReviewIntegrationService integration', () => {
  it('removes the temporary integration worktree after integration', async () => {
    const fixture = await setup();
    try {
      const review = await fixture.requestPass((await fixture.publishedCandidate('cleanup-integration')).id);
      await fixture.service.integrate(review.id);
      expect(await exists(join(fixture.storage, 'integrations', review.id))).toBe(false);
    } finally { await fixture.dispose(); }
  });
  it('integrates with a non-fast-forward merge and advances the canonical dev base', async () => {
    const fixture = await setup();
    try {
      const run = await fixture.publishedCandidate('merge'); const review = await fixture.requestPass(run.id);
      const integrated = await fixture.service.integrate(review.id);
      const remoteDev = await fixture.remoteRef('dev');
      expect(integrated).toMatchObject({ integrationStatus: 'integrated', integrationCommitSha: remoteDev });
      expect((await fixture.git(['rev-list', '--parents', '-n', '1', remoteDev])).stdout.trim().split(' ')).toHaveLength(3);
      expect(await resolveEffectiveDevBase(fixture.repository, fixture.workspace.id, fixture.settings)).toBe(remoteDev);
    } finally { await fixture.dispose(); }
  });

  it('keeps canonical dev continuous for the next planner base and review target', async () => {
    const fixture = await setup();
    try {
      const first = await fixture.publishedCandidate('first', undefined, undefined, false); const integrated = await fixture.service.integrate((await fixture.requestPass(first.id)).id);
      const next = await fixture.publishedCandidate('second', undefined, undefined, false);
      const review = await fixture.requestPass(next.id);
      expect(await resolveEffectiveDevBase(fixture.repository, fixture.workspace.id, fixture.settings)).toBe(integrated.integrationCommitSha);
      expect(review.targetDevSha).toBe(integrated.integrationCommitSha);
      const second = await fixture.service.integrate(review.id);
      expect(await resolveEffectiveDevBase(fixture.repository, fixture.workspace.id, fixture.settings)).toBe(second.integrationCommitSha);
    } finally { await fixture.dispose(); }
  });

  it('marks stale candidates and unrelated remote dev movement without merging', async () => {
    await Promise.all([(async () => {
      const fixture = await setup();
      try { const run = await fixture.publishedCandidate('stale'); const review = await fixture.requestPass(run.id); await fixture.commitAndPushCandidateReplacement(run.candidateBranchName!); expect((await fixture.service.integrate(review.id)).staleAt).toBeTruthy(); } finally { await fixture.dispose(); }
    })(), (async () => {
      const fixture = await setup();
      try { const run = await fixture.publishedCandidate('remote-moved'); const review = await fixture.requestPass(run.id); await fixture.advanceDev('unrelated'); const stale = await fixture.service.integrate(review.id); expect(stale).toMatchObject({ integrationStatus: 'rejected' }); expect(stale.staleReason).toContain('no longer matches'); } finally { await fixture.dispose(); }
    })()]);
  });

  it('reports merge conflicts and failed integration validation for attention', async () => {
    await Promise.all([(async () => {
      const fixture = await setup();
      try { const run = await fixture.publishedCandidate('conflict', 'candidate\n', 'shared.txt'); await fixture.advanceDev('dev\n', 'shared.txt'); const result = await fixture.service.integrate((await fixture.requestPass(run.id)).id); expect(result).toMatchObject({ integrationStatus: 'needs_attention' }); expect(result.integrationFailureReason).toContain('Merge conflict'); } finally { await fixture.dispose(); }
    })(), (async () => {
      const fixture = await setup({ validator: { validate: () => Promise.resolve({ passed: false, evidence: 'lint failed', commands: [{ sequence: 0, command: 'npm run lint', status: 'failed' as const, startedAt: '2026-08-27T00:00:00.000Z', finishedAt: '2026-08-27T00:00:01.000Z', exitCode: 2, output: 'useful stderr', outputTruncated: false }] }) } });
      try { const result = await fixture.service.integrate((await fixture.requestPass((await fixture.publishedCandidate('invalid')).id)).id); expect(result).toMatchObject({ integrationStatus: 'needs_attention', integrationValidation: 'lint failed' }); expect(result.integrationValidationCommands).toMatchObject([{ command: 'npm run lint', status: 'failed', exitCode: 2, output: 'useful stderr' }]); } finally { await fixture.dispose(); }
    })()]);
  });

  it('detects a remote race immediately before push', async () => {
    const fixture = await setup({ validator: { validate: async () => { await fixture.advanceDev('race'); return { passed: true, evidence: 'ok' }; } } });
    try {
      const result = await fixture.service.integrate((await fixture.requestPass((await fixture.publishedCandidate('race-candidate')).id)).id);
      expect(result).toMatchObject({ integrationStatus: 'rejected' }); expect(result.staleReason).toContain('Remote dev moved before push');
    } finally { await fixture.dispose(); }
  });

  it('persists the expected integration SHA before pushing', async () => {
    const fixture = await setup();
    try {
      const run = await fixture.publishedCandidate('pre-push'); const review = await fixture.requestPass(run.id); let persisted: string | null = null;
      fixture.setGit(async (path, args) => {
        if (args[0] === 'push') persisted = fixture.reviews.findRequired(review.id).integrationCommitSha;
        return runGit(path, args);
      });
      await fixture.service.integrate(review.id);
      expect(persisted).toMatch(/^[0-9a-f]{40}$/);
    } finally { await fixture.dispose(); }
  });

  it('recovers exactly an already-pushed integration after a crash and is idempotent', async () => {
    const fixture = await setup();
    try {
      const run = await fixture.publishedCandidate('recovery'); const review = await fixture.requestPass(run.id);
      const mergeSha = await fixture.createMergeOnDev(run.candidateCommitSha!);
      fixture.reviews.setIntegration(review.id, 'integrating', { commitSha: mergeSha, validation: 'ok' });
      const recovered = await fixture.service.integrate(review.id);
      expect(recovered).toMatchObject({ integrationStatus: 'integrated', integrationCommitSha: mergeSha });
      await expect(fixture.service.integrate(review.id)).resolves.toEqual(recovered);
    } finally { await fixture.dispose(); }
  });

  it('does not mistake unrelated remote movement for an already-pushed integration', async () => {
    const fixture = await setup();
    try {
      const run = await fixture.publishedCandidate('wrong-recovery'); const review = await fixture.requestPass(run.id);
      fixture.reviews.setIntegration(review.id, 'integrating', { commitSha: run.candidateCommitSha, validation: 'ok' });
      await fixture.advanceDev('unrelated-remote');
      const result = await fixture.service.integrate(review.id);
      expect(result).not.toMatchObject({ integrationStatus: 'integrated' }); expect(result.staleAt).toBeTruthy();
    } finally { await fixture.dispose(); }
  });
});

describe.skipIf(process.platform !== 'win32')('ReviewIntegrationService integration dependency junctions', () => {
  it.each(['manual', 'automatic'] as const)('runs deterministic validation with source dependencies during %s integration and safely cleans up', async (mode) => {
    const fixture = await setup({ validator: new SupervisedIntegrationValidator() });
    const modulePath = join(fixture.repository, 'node_modules', 'nightshift-local-validation-tool'); const sentinel = join(modulePath, 'sentinel.txt');
    try {
      const validationCommand = "node -e \"require('nightshift-local-validation-tool')()\"";
      await fixture.advanceDev(`${JSON.stringify({ scripts: { typecheck: validationCommand, lint: validationCommand, test: validationCommand, build: validationCommand } })}\n`, 'package.json');
      await mkdir(modulePath, { recursive: true }); await writeFile(join(modulePath, 'index.js'), "module.exports = () => process.stdout.write('local validation tool\\n');\n"); await writeFile(sentinel, 'source-owned\n');
      const run = await fixture.publishedCandidate(`${mode}-local-tool`);
      const result = mode === 'manual'
        ? await fixture.service.integrate((await fixture.requestPass(run.id)).id)
        : (fixture.settings.set(candidateProgressionKey(fixture.workspace.id), 'auto_review_integrate'), await fixture.service.resumeAutomaticWork(), fixture.reviews.latest(run.id)!);
      expect(result).toMatchObject({ integrationStatus: 'integrated' }); expect(result.integrationValidation).toContain('$ npm run build'); expect(await readFile(sentinel, 'utf8')).toBe('source-owned\n');
    } finally { await fixture.dispose(); }
  });
});

describe('SupervisedIntegrationValidator', () => {
  it('uses one deadline across validation scripts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nightshift-integration-deadline-')); const supervisor = new DeadlineSupervisor();
    const now = vi.spyOn(Date, 'now').mockReturnValueOnce(100).mockReturnValueOnce(100).mockReturnValue(110);
    try {
      await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { typecheck: 'ok', lint: 'hang', test: 'later' } }));
      const result = await new SupervisedIntegrationValidator(supervisor, 10).validate(root);
      expect(result.passed).toBe(false); expect(supervisor.started).toHaveLength(2); expect(supervisor.cancelled).toEqual([supervisor.started[1]]);
    } finally { now.mockRestore(); await rm(root, { recursive: true, force: true }); }
  });
});

let templateRoot = ''; let templateRepository = ''; let templateRemote = '';

beforeAll(async () => {
  templateRoot = await mkdtemp(join(tmpdir(), 'nightshift-review-template-')); templateRepository = join(templateRoot, 'repo'); templateRemote = join(templateRoot, 'remote.git');
  await exec('git', ['init', templateRepository]); await exec('git', ['-C', templateRepository, 'config', 'user.email', 'test@nightshift.local']); await exec('git', ['-C', templateRepository, 'config', 'user.name', 'NightShift Test']); await exec('git', ['-C', templateRepository, 'branch', '-M', 'dev']); await writeFile(join(templateRepository, 'shared.txt'), 'base\n'); await exec('git', ['-C', templateRepository, 'add', '.']); await exec('git', ['-C', templateRepository, 'commit', '-m', 'base']); await exec('git', ['init', '--bare', templateRemote]); await exec('git', ['-C', templateRepository, 'remote', 'add', 'origin', templateRemote]); await exec('git', ['-C', templateRepository, 'push', '-u', 'origin', 'dev']); await exec('git', ['--git-dir', templateRemote, 'symbolic-ref', 'HEAD', 'refs/heads/dev']);
});

describe('ReviewIntegrationService automatic progression', () => {
  it('retries a needs-attention Candidate with the same SHA against current dev and preserves history', async () => {
    let passes = false;
    const fixture = await setup({ validator: { validate: () => Promise.resolve(passes ? { passed: true, evidence: 'retry passed' } : { passed: false, evidence: 'integrated-tree failure' }) } });
    try {
      const run = await fixture.publishedCandidate('explicit-retry');
      fixture.settings.set(candidateProgressionKey(fixture.workspace.id), 'auto_review_integrate');
      await fixture.service.resumeAutomaticWork();
      const first = fixture.reviews.latest(run.id)!;
      const candidateSha = run.candidateCommitSha;
      expect(first.integrationStatus).toBe('needs_attention');
      const currentDev = await fixture.advanceDev('current dev');
      passes = true;
      const retried = await fixture.service.retryIntegration(run.id);
      const history = fixture.reviews.listByRunIds([run.id]);
      expect(history).toHaveLength(2);
      expect(history.find((value) => value.id === first.id)).toMatchObject({ integrationStatus: 'needs_attention', integrationValidation: 'integrated-tree failure' });
      expect(run.candidateCommitSha).toBe(candidateSha);
      expect(history.map((value) => value.candidateSha)).toEqual([candidateSha, candidateSha]);
      expect(retried).toMatchObject({ integrationStatus: 'integrated', candidateSha, targetDevSha: currentDev });
      expect(await fixture.remoteRef('dev')).toBe(retried.integrationCommitSha);
    } finally { await fixture.dispose(); }
  });

  it('serializes explicit retries through the workspace integration queue', async () => {
    let phase: 'failing' | 'passing' = 'failing'; let active = 0; let maximum = 0; let blocked = false; let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fixture = await setup({ validator: { validate: async () => { if (phase === 'failing') return { passed: false, evidence: 'initial failure' }; active += 1; maximum = Math.max(maximum, active); if (!blocked) { blocked = true; await gate; } active -= 1; return { passed: true, evidence: 'retry passed' }; } } });
    try {
      const first = await fixture.publishedCandidate('explicit-serial-first'); const second = await fixture.publishedCandidate('explicit-serial-second');
      fixture.settings.set(candidateProgressionKey(fixture.workspace.id), 'auto_review_integrate'); await fixture.service.resumeAutomaticWork();
      expect(fixture.reviews.latest(first.id)?.integrationStatus).toBe('needs_attention'); expect(fixture.reviews.latest(second.id)?.integrationStatus).toBe('needs_attention');
      phase = 'passing'; const processing = Promise.all([fixture.service.retryIntegration(first.id), fixture.service.retryIntegration(second.id)]);
      for (let attempt = 0; !blocked && attempt < 100; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(maximum).toBe(1); release?.(); const [firstRetry, secondRetry] = await processing;
      expect(firstRetry.integrationStatus).toBe('integrated'); expect(secondRetry.integrationStatus).toBe('integrated'); expect(maximum).toBe(1);
    } finally { release?.(); await fixture.dispose(); }
  }, 20_000);

  it('does not retry an already integrated Candidate', async () => {
    const fixture = await setup();
    try {
      const run = await fixture.publishedCandidate('explicit-retry-integrated');
      await fixture.service.integrate((await fixture.requestPass(run.id)).id);
      await expect(fixture.service.retryIntegration(run.id)).rejects.toThrow('Integrated Candidates cannot be retried.');
      expect(fixture.reviews.listByRunIds([run.id])).toHaveLength(1);
    } finally { await fixture.dispose(); }
  });

  it('keeps candidate_only manual', async () => {
    const fixture = await setup();
    try {
      await fixture.publishedCandidate('manual');
      await fixture.service.resumeAutomaticWork();
      expect(fixture.reviewer.inputs).toHaveLength(0);
      expect(await fixture.remoteRef('dev')).toBe(await fixture.git(['rev-parse', 'dev']).then((value) => value.stdout.trim()));
    } finally { await fixture.dispose(); }
  });

  it('reviews without merging in auto_review mode', async () => {
    const fixture = await setup();
    try {
      const before = await fixture.remoteRef('dev'); const run = await fixture.publishedCandidate('review-only');
      fixture.settings.set(candidateProgressionKey(fixture.workspace.id), 'auto_review'); await fixture.service.resumeAutomaticWork();
      expect(fixture.reviewer.inputs).toHaveLength(1); expect(fixture.reviews.latest(run.id)?.integrationStatus).toBe('not_started'); expect(await fixture.remoteRef('dev')).toBe(before);
    } finally { await fixture.dispose(); }
  });

  it('serially integrates same-base candidates and reviews each merged result', async () => {
    const fixture = await setup();
    try {
      const base = (await fixture.git(['rev-parse', 'dev'])).stdout.trim();
      const first = await fixture.publishedCandidate('auto-first', 'first\n', 'first.txt', true, base);
      const second = await fixture.publishedCandidate('auto-second', 'second\n', 'second.txt', true, base);
      fixture.settings.set(candidateProgressionKey(fixture.workspace.id), 'auto_review_integrate'); await fixture.service.resumeAutomaticWork();
      const firstReview = fixture.reviews.latest(first.id)!; const secondReview = fixture.reviews.latest(second.id)!;
      expect(firstReview.integrationStatus).toBe('integrated'); expect(secondReview.integrationStatus).toBe('integrated');
      expect(fixture.reviewer.inputs.map((input) => input.candidateSha)).toEqual([firstReview.integrationCommitSha, secondReview.integrationCommitSha]);
      expect(fixture.reviewer.inputs[1]!.targetDevSha).toBe(firstReview.integrationCommitSha);
      expect((await fixture.git(['rev-list', '--parents', '-n', '1', secondReview.integrationCommitSha!])).stdout.trim().split(' ')).toContain(firstReview.integrationCommitSha);
    } finally { await fixture.dispose(); }
  });

  it('allows only one automatic integration per workspace at a time', async () => {
    let active = 0; let maximum = 0; let release: (() => void) | undefined; const gate = new Promise<void>((resolve) => { release = resolve; });
    const fixture = await setup({ validator: { validate: async () => { active += 1; maximum = Math.max(maximum, active); if (maximum === 1) await gate; active -= 1; return { passed: true, evidence: 'ok' }; } } });
    try {
      const base = (await fixture.git(['rev-parse', 'dev'])).stdout.trim(); await fixture.publishedCandidate('serialized-first', 'first\n', 'first.txt', true, base); await fixture.publishedCandidate('serialized-second', 'second\n', 'second.txt', true, base);
      fixture.settings.set(candidateProgressionKey(fixture.workspace.id), 'auto_review_integrate'); const processing = fixture.service.resumeAutomaticWork();
      for (let attempt = 0; maximum === 0 && attempt < 100; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 25));
      expect(maximum).toBe(1); release?.(); await processing; expect(maximum).toBe(1);
    } finally { await fixture.dispose(); }
  });

  it('drains a Candidate published while an automatic integration is active', async () => {
    let active = 0; let maximum = 0; let release: (() => void) | undefined; const gate = new Promise<void>((resolve) => { release = resolve; });
    const fixture = await setup({ validator: { validate: async () => { active += 1; maximum = Math.max(maximum, active); if (maximum === 1) await gate; active -= 1; return { passed: true, evidence: 'ok' }; } } });
    try {
      const first = await fixture.publishedCandidate('wake-first'); fixture.settings.set(candidateProgressionKey(fixture.workspace.id), 'auto_review_integrate'); const processing = fixture.service.resumeAutomaticWork();
      for (let attempt = 0; maximum === 0 && attempt < 100; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 25));
      const second = await fixture.publishedCandidate('wake-second'); fixture.service.onCandidatePublished(second); release?.(); await processing;
      expect(fixture.reviews.latest(first.id)?.integrationStatus).toBe('integrated'); expect(fixture.reviews.latest(second.id)?.integrationStatus).toBe('integrated'); expect(maximum).toBe(1);
    } finally { await fixture.dispose(); }
  });

  it('continues after a reviewer failure', async () => {
    const fixture = await setup();
    try {
      const failed = await fixture.publishedCandidate('review-fail'); const succeeding = await fixture.publishedCandidate('after-fail');
      fixture.reviewer.responses = [JSON.stringify({ verdict: 'FAIL', summary: 'no', findings: 'no' }), JSON.stringify({ verdict: 'PASS', summary: 'yes', findings: 'yes' })];
      fixture.settings.set(candidateProgressionKey(fixture.workspace.id), 'auto_review_integrate'); await fixture.service.resumeAutomaticWork();
      expect(fixture.reviews.latest(failed.id)?.integrationStatus).toBe('needs_attention'); expect(fixture.reviews.latest(succeeding.id)?.integrationStatus).toBe('integrated');
    } finally { await fixture.dispose(); }
  });

  it('never overwrites dev after an automatic remote race', async () => {
    const fixture = await setup({ validator: { validate: async () => { await fixture.advanceDev('external-race'); return { passed: true, evidence: 'ok' }; } } });
    try {
      const raced = await fixture.publishedCandidate('race-auto'); fixture.settings.set(candidateProgressionKey(fixture.workspace.id), 'auto_review_integrate'); await fixture.service.resumeAutomaticWork();
      expect(fixture.reviews.latest(raced.id)?.staleAt).toBeTruthy(); expect((await fixture.remoteRef('dev'))).not.toBe(fixture.reviews.latest(raced.id)?.integrationCommitSha);
    } finally { await fixture.dispose(); }
  });

  it('resumes pending automatic work after service recreation', async () => {
    const fixture = await setup();
    try {
      const run = await fixture.publishedCandidate('resume-auto'); fixture.settings.set(candidateProgressionKey(fixture.workspace.id), 'auto_review_integrate');
      fixture.recreateService(); await fixture.service.resumeAutomaticWork();
      expect(fixture.reviews.latest(run.id)?.integrationStatus).toBe('integrated');
    } finally { await fixture.dispose(); }
  });
});

afterAll(async () => { if (templateRoot) await rm(templateRoot, { recursive: true, force: true, maxRetries: 4, retryDelay: 75 }); });

const setup = async (overrides: { validator?: IntegrationValidator; remote?: boolean } = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'nightshift-review-integration-')); const repository = join(root, 'repo'); const remote = join(root, 'remote.git'); const storage = join(root, 'storage'); const database = new DatabaseService(':memory:'); const hasRemote = overrides.remote ?? true;
  await cp(templateRepository, repository, { recursive: true });
  if (hasRemote) { await cp(templateRemote, remote, { recursive: true }); await exec('git', ['-C', repository, 'remote', 'set-url', 'origin', remote]); }
  const workspaces = new WorkspaceRepository(database); const tasks = new PlannerTaskRepository(database); const runs = new RunRepository(database); const reviews = new RunIntegrationReviewRepository(database); const settings = new SettingsRepository(database); const workspace = workspaces.addOrTouch(repository, 'repo', true); const reviewer = new FakeReviewer(); let git: GitCommand = runGit;
  const makeService = () => new ReviewIntegrationService(runs, workspaces, reviews, reviewer, { automationEvidence: () => Promise.resolve({ review: { source: 'test' } }) } as never, storage, settings, overrides.validator ?? { validate: () => Promise.resolve({ passed: true, evidence: 'ok' }) }, (path, args) => git(path, args));
  let service = makeService();
  const gitCommand = (args: readonly string[]) => runGit(repository, args);
  const publishedCandidate = async (name: string, content = `${name}\n`, file = `${name}.txt`, restoreDev = true, baseRef?: string) => {
    const base = baseRef ?? settings.get<string>(devBaseKey(workspace.id)) ?? 'dev'; const branch = `candidate-${name}`;
    await gitCommand(['switch', '-c', branch, base]); await writeFile(join(repository, file), content); await gitCommand(['add', file]); await gitCommand(['commit', '-m', name]); const sha = (await gitCommand(['rev-parse', 'HEAD'])).stdout.trim(); if (hasRemote) await gitCommand(['push', '-u', 'origin', branch]); if (restoreDev) await gitCommand(['switch', 'dev']);
    const task = tasks.create({ workspaceId: workspace.id, prompt: name, requestedAgentId: 'reviewer', requestedModelId: 'model', priority: 1 }); const run = runs.create({ taskId: task.id, workspaceId: workspace.id, resolvedAgentId: 'reviewer', resolvedModelId: 'model' }); runs.setCandidateCommit(run.id, branch, sha); runs.setCandidatePublished(run.id, 'origin'); return runs.setStatus(run.id, 'completed', { validation_status: 'passed' });
  };
  const advanceDev = async (content: string, file = `dev-${Date.now()}.txt`) => { await writeFile(join(repository, file), content); await gitCommand(['add', file]); await gitCommand(['commit', '-m', 'advance dev']); await gitCommand(['push', 'origin', 'dev']); return (await gitCommand(['rev-parse', 'HEAD'])).stdout.trim(); };
  const createMergeOnDev = async (candidate: string) => { await gitCommand(['merge', '--no-ff', '--no-edit', candidate]); const sha = (await gitCommand(['rev-parse', 'HEAD'])).stdout.trim(); await gitCommand(['push', 'origin', 'dev']); return sha; };
  const requestPass = async (runId: string) => { const run = runs.findRequired(runId); return reviews.create({ runId, candidateSha: run.candidateCommitSha!, targetDevSha: await resolveEffectiveDevBase(repository, workspace.id, settings), reviewerAgentId: run.resolvedAgentId, reviewerModelId: run.resolvedModelId, verdict: 'PASS', summary: 'approved', findings: 'none' }); };
  return { repository, remote, storage, workspace, settings, reviews, reviewer, get service() { return service; }, recreateService: () => { service = makeService(); }, setGit: (value: GitCommand) => { git = value; service = makeService(); }, publishedCandidate, advanceDev, createMergeOnDev, requestPass, remoteRef: async (branch: string) => (await gitCommand(['ls-remote', 'origin', `refs/heads/${branch}`])).stdout.trim().split('\t')[0] ?? '', git: gitCommand, commitAndPushCandidateReplacement: async (branch: string) => { await gitCommand(['switch', branch]); await writeFile(join(repository, 'replacement.txt'), 'replacement\n'); await gitCommand(['add', '.']); await gitCommand(['commit', '-m', 'replacement']); await gitCommand(['push', 'origin', branch, '--force']); await gitCommand(['switch', 'dev']); }, dispose: async () => { database.close(); await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 75 }); } };
};

const exists = async (path: string): Promise<boolean> => access(path).then(() => true, () => false);

class FakeReviewer implements ReviewerRunner {
  public raw = JSON.stringify({ verdict: 'PASS', summary: 'approved', findings: 'none' }); public responses: string[] = []; public error: Error | undefined; public mutate = false; public readonly inputs: Parameters<ReviewerRunner['review']>[0][] = [];
  public reset(): void { this.raw = JSON.stringify({ verdict: 'PASS', summary: 'approved', findings: 'none' }); this.responses = []; this.error = undefined; this.mutate = false; this.inputs.length = 0; }
  public async review(input: Parameters<ReviewerRunner['review']>[0]): Promise<string> { this.inputs.push(input); if (this.mutate) await writeFile(join(input.worktreePath, 'mutation.txt'), 'unsafe\n'); if (this.error) throw this.error; return this.responses.shift() ?? this.raw; }
}

class DeadlineSupervisor implements ProcessSupervisor {
  public readonly started: string[] = []; public readonly cancelled: string[] = []; private readonly completions = new Map<string, (result: SupervisedProcessResult) => void>();
  public start(spec: Parameters<ProcessSupervisor['start']>[0]): Promise<SupervisedProcessSnapshot> { this.started.push(spec.executionId); return Promise.resolve({ executionId: spec.executionId, processId: 1, state: 'running', startedAt: '', lastOutputAt: null, finishedAt: null, cancellationRequested: false, exitCode: null, failureReason: null }); }
  public cancelOwnedTree(id: string): Promise<void> { this.cancelled.push(id); this.completions.get(id)?.({ executionId: id, processId: 1, state: 'exited', startedAt: '', lastOutputAt: null, finishedAt: '', cancellationRequested: true, exitCode: 1, failureReason: null, signal: null, stdout: '', stderr: '' }); return Promise.resolve(); }
  public snapshot(): SupervisedProcessSnapshot | undefined { return undefined; }
  public subscribe(): () => void { return () => undefined; }
  public waitForCompletion(id: string): Promise<SupervisedProcessResult> { if (this.started.length === 1) return Promise.resolve({ executionId: id, processId: 1, state: 'exited', startedAt: '', lastOutputAt: null, finishedAt: '', cancellationRequested: false, exitCode: 0, failureReason: null, signal: null, stdout: '', stderr: '' }); return new Promise((resolve) => this.completions.set(id, resolve)); }
}
