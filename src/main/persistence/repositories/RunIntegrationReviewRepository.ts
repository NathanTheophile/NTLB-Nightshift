import { randomUUID } from 'node:crypto';
import type { IntegrationStatus, RunIntegrationReview, ReviewerVerdict } from '@shared/domain/entities';
import type { DatabaseService } from '../DatabaseService';

interface Row { id: string; run_id: string; candidate_sha: string; target_dev_sha: string; reviewer_agent_id: string; reviewer_model_id: string; verdict: ReviewerVerdict; summary: string; findings: string; created_at: string; reviewed_at: string; stale_at: string | null; stale_reason: string | null; integration_status: IntegrationStatus; integration_commit_sha: string | null; integration_validation: string | null; integration_failure_reason: string | null; integrated_at: string | null; }
const map = (row: Row): RunIntegrationReview => ({ id: row.id, runId: row.run_id, candidateSha: row.candidate_sha, targetDevSha: row.target_dev_sha, reviewerAgentId: row.reviewer_agent_id, reviewerModelId: row.reviewer_model_id, verdict: row.verdict, summary: row.summary, findings: row.findings, createdAt: row.created_at, reviewedAt: row.reviewed_at, staleAt: row.stale_at, staleReason: row.stale_reason, integrationStatus: row.integration_status, integrationCommitSha: row.integration_commit_sha, integrationValidation: row.integration_validation, integrationFailureReason: row.integration_failure_reason, integratedAt: row.integrated_at });

export class RunIntegrationReviewRepository {
  public constructor(private readonly database: DatabaseService) {}
  public create(input: Omit<RunIntegrationReview, 'id' | 'createdAt' | 'reviewedAt' | 'staleAt' | 'staleReason' | 'integrationStatus' | 'integrationCommitSha' | 'integrationValidation' | 'integrationFailureReason' | 'integratedAt'>): RunIntegrationReview {
    const id = randomUUID(); const now = new Date().toISOString();
    this.database.execute(`INSERT INTO run_integration_reviews(id, run_id, candidate_sha, target_dev_sha, reviewer_agent_id, reviewer_model_id, verdict, summary, findings, created_at, reviewed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, input.runId, input.candidateSha, input.targetDevSha, input.reviewerAgentId, input.reviewerModelId, input.verdict, input.summary, input.findings, now, now);
    return this.findRequired(id);
  }
  public find(id: string): RunIntegrationReview | undefined { const row = this.database.queryOne<Row>('SELECT * FROM run_integration_reviews WHERE id = ?', id); return row ? map(row) : undefined; }
  public findRequired(id: string): RunIntegrationReview { const value = this.find(id); if (!value) throw new Error(`Review ${id} was not found.`); return value; }
  public latest(runId: string): RunIntegrationReview | undefined { const row = this.database.queryOne<Row>('SELECT * FROM run_integration_reviews WHERE run_id = ? ORDER BY created_at DESC LIMIT 1', runId); return row ? map(row) : undefined; }
  public listByRunIds(runIds: readonly string[]): RunIntegrationReview[] {
    if (!runIds.length) return [];
    const placeholders = runIds.map(() => '?').join(', ');
    return this.database.queryAll<Row>(`SELECT * FROM run_integration_reviews WHERE run_id IN (${placeholders})`, ...runIds).map(map);
  }
  public markStale(id: string, reason: string): RunIntegrationReview { this.database.execute("UPDATE run_integration_reviews SET stale_at = ?, stale_reason = ?, integration_status = CASE WHEN integration_status = 'integrated' THEN integration_status ELSE 'rejected' END WHERE id = ?", new Date().toISOString(), reason, id); return this.findRequired(id); }
  public setVerdict(id: string, verdict: ReviewerVerdict, summary: string, findings: string): RunIntegrationReview { this.database.execute('UPDATE run_integration_reviews SET verdict = ?, summary = ?, findings = ?, reviewed_at = ? WHERE id = ?', verdict, summary, findings, new Date().toISOString(), id); return this.findRequired(id); }
  public setIntegration(id: string, status: IntegrationStatus, values: { commitSha?: string | null; validation?: string | null; failureReason?: string | null } = {}): RunIntegrationReview { this.database.execute('UPDATE run_integration_reviews SET integration_status = ?, integration_commit_sha = ?, integration_validation = ?, integration_failure_reason = ?, integrated_at = CASE WHEN ? = \'integrated\' THEN ? ELSE integrated_at END WHERE id = ?', status, values.commitSha ?? null, values.validation ?? null, values.failureReason ?? null, status, new Date().toISOString(), id); return this.findRequired(id); }
}
