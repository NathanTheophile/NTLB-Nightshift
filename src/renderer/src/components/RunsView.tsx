import { useCallback, useEffect, useState } from 'react';
import type { PlannerTask, Run, RunIntegrationReview, RunReview, Workspace } from '@shared/domain/entities';
import { EmptyState } from './EmptyState';
import { RunDetailCard } from './RunDetailCard';

interface RunsViewProps { workspace: Workspace; selectedRunId: string | null; onSelectRun: (runId: string | null) => void; onError: (message: string) => void; }

export const RunsView = ({ workspace, selectedRunId, onSelectRun, onError }: RunsViewProps) => {
  const [runs, setRuns] = useState<Run[]>([]); const [tasks, setTasks] = useState<PlannerTask[]>([]); const [review, setReview] = useState<RunReview | null>(null); const [integration, setIntegration] = useState<RunIntegrationReview | null>(null);
  const selected = runs.find((run) => run.id === selectedRunId) ?? null; const task = tasks.find((item) => item.id === selected?.taskId) ?? null;
  const refresh = useCallback(async () => { try { const [nextRuns, nextTasks] = await Promise.all([window.nightShift.runs.list(workspace.id), window.nightShift.planner.listTasks(workspace.id)]); setRuns(nextRuns); setTasks(nextTasks); if (selectedRunId && !nextRuns.some((run) => run.id === selectedRunId)) onSelectRun(nextRuns[0]?.id ?? null); } catch (error) { onError(message(error)); } }, [onError, onSelectRun, selectedRunId, workspace.id]);
  useEffect(() => { const initial = window.setTimeout(() => void refresh(), 0); const timer = window.setInterval(() => void refresh(), 1_500); return () => { window.clearTimeout(initial); window.clearInterval(timer); }; }, [refresh]);
  useEffect(() => { if (selected) void Promise.all([window.nightShift.runs.review(selected.id), window.nightShift.runs.reviewIntegration(selected.id)]).then(([nextReview, nextIntegration]) => { setReview(nextReview); setIntegration(nextIntegration); }).catch((error: unknown) => onError(message(error))); }, [onError, selected]);
  if (!selected) return <section className="runs-view"><EmptyState eyebrow="RUNS" title="Aucune tentative" detail="Les tentatives Planner persistées apparaîtront ici." /></section>;
  if (!review) return <section className="runs-view"><p className="boot-status">Chargement du Run…</p></section>;
  return <section className="runs-view"><RunDetailCard run={selected} task={task} review={review} integration={integration} onRefresh={refresh} onError={onError} /></section>;
};
const message = (error: unknown): string => error instanceof Error ? error.message : 'NightShift could not load Run history.';
