import { useCallback, useEffect, useState } from 'react';

import type { Run, RunEvent, Workspace } from '@shared/domain/entities';

import { EmptyState } from './EmptyState';

export const RunsView = ({ workspace, onError }: { workspace: Workspace; onError: (message: string) => void }) => {
  const [runs, setRuns] = useState<Run[]>([]);
  const [selected, setSelected] = useState<Run | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const refresh = useCallback(async (): Promise<void> => {
    try { const next = await window.nightShift.runs.list(workspace.id); setRuns(next); setSelected((current) => next.find((run) => run.id === current?.id) ?? next[0] ?? null); } catch (error) { onError(message(error)); }
  }, [onError, workspace.id]);
  useEffect(() => { const initial = window.setTimeout(() => void refresh(), 0); const timer = window.setInterval(() => void refresh(), 1500); return () => { window.clearTimeout(initial); window.clearInterval(timer); }; }, [refresh]);
  useEffect(() => { if (!selected) return; const timer = window.setTimeout(() => { void window.nightShift.runs.events(selected.id).then(setEvents).catch((error: unknown) => onError(message(error))); }, 0); return () => window.clearTimeout(timer); }, [onError, selected]);
  return <section className="runs-view">
    <div className="runs-list">{runs.length === 0 ? <EmptyState eyebrow="RUNS" title="Aucune tentative" detail="Les tentatives Planner persistées apparaîtront ici." /> : runs.map((run) => <button className={`run-row ${selected?.id === run.id ? 'is-selected' : ''}`} type="button" onClick={() => setSelected(run)} key={run.id}><span className={`status status-${run.status}`}>{run.status}</span><strong>{run.resolvedAgentId} · {run.resolvedModelId}</strong><small>{new Date(run.createdAt).toLocaleString()}</small></button>)}</div>
    <aside className="run-detail">{selected && <><header><div><span className={`status status-${selected.status}`}>{selected.status}</span><strong>Run {selected.id.slice(0, 8)}</strong></div>{['preparing', 'running', 'cancel_requested'].includes(selected.status) && <button type="button" onClick={() => void window.nightShift.runs.cancel(selected.id).then(refresh).catch((error: unknown) => onError(message(error)))}>Annuler</button>}</header><dl><dt>Session Claude</dt><dd>{selected.externalSessionId ?? '—'}</dd><dt>Base SHA</dt><dd>{selected.baseSha ?? '—'}</dd><dt>Worktree</dt><dd>{selected.worktreePath ?? '—'}</dd><dt>Final Git</dt><dd>{selected.finalHeadSha ?? '—'}</dd><dt>Erreur</dt><dd>{selected.failureReason ?? '—'}</dd></dl><div className="run-events">{events.map((event) => <p key={event.id}><time>{new Date(event.timestamp).toLocaleTimeString()}</time> <strong>{event.eventType}</strong> {JSON.stringify(event.payload)}</p>)}</div></>}</aside>
  </section>;
};

const message = (error: unknown): string => error instanceof Error ? error.message : 'NightShift could not load Run history.';
