import { useCallback, useEffect, useState } from 'react';
import type { PlannerTask, Run, RunEventKind, RunEventPage, RunIntegrationReview, RunReview } from '@shared/domain/entities';
import type { WorkspaceTool } from '@shared/contracts/ipc';
import { assets } from '../assets';
import { canCancelRun, normalizeFollowUpPrompt } from '@shared/domain/runActions';

type Tab = 'prompt' | 'changes' | 'activity' | 'protocol';
const tabs: readonly [Tab, string][] = [['prompt', 'Prompt / Result'], ['changes', 'Changes / Diff'], ['activity', 'Activity'], ['protocol', 'Raw Protocol']];
const streamFor = (tab: Tab): RunEventKind | null => tab === 'activity' ? 'activity' : tab === 'protocol' ? 'raw_protocol' : null;

export const RunDetailCard = ({ run, task, review, integration, onRefresh, onFollowUpCreated, onError }: { run: Run; task: PlannerTask | null; review: RunReview; integration: RunIntegrationReview | null; onRefresh: () => Promise<void>; onFollowUpCreated: (run: Run) => Promise<void>; onError: (message: string) => void }) => {
  const [tab, setTab] = useState<Tab>('prompt');
  const [expanded, setExpanded] = useState(false);
  const [path, setPath] = useState<string | null>(null);
  const [diff, setDiff] = useState('');
  const [events, setEvents] = useState<RunEventPage | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [cancelPending, setCancelPending] = useState(false);
  const [durationText, setDurationText] = useState('Not started');

  const open = (tool: WorkspaceTool) => void window.nightShift.runs.openWorktree(run.id, tool).catch((error: unknown) => onError(message(error)));
  const loadEvents = useCallback((nextCursor: number | null) => { const kind = streamFor(tab); if (!kind) return; void window.nightShift.runs.events({ runId: run.id, kind, cursor: nextCursor, limit: 100 }).then((page) => { setCursor(nextCursor); setEvents(page); }).catch((error: unknown) => onError(message(error))); }, [onError, run.id, tab]);
  useEffect(() => {
    if (streamFor(tab)) loadEvents(null);
  }, [loadEvents, tab]);
  const loadDiff = (nextPath: string) => void window.nightShift.runs.fileDiff(run.id, nextPath).then((next) => { setPath(nextPath); setDiff(next.content ?? next.note ?? 'No diff available.'); }).catch((error: unknown) => onError(message(error)));
  const action = (operation: Promise<unknown>) => void operation.then(onRefresh).catch((error: unknown) => onError(message(error)));
  const cancel = async (): Promise<void> => { setCancelPending(true); try { await window.nightShift.runs.cancel(run.id); await onRefresh(); } catch (error) { setCancelPending(false); onError(message(error)); } };

  // Helper to format duration in human readable format
  const formatDuration = (startedAt: number, finishedAt?: number): string => {
    const end = finishedAt ?? Date.now();
    const diffMs = end - startedAt;
    const totalSeconds = Math.floor(diffMs / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const parts: string[] = [];
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
    return parts.join(' ');
  };

  // Update duration whenever startedAt or finishedAt changes using useEffect with cleanup
  useEffect(() => {
    const updateDuration = () => {
      if (!run.startedAt) {
        setDurationText('Not started');
        return;
      }

      const start = parseInt(run.startedAt, 10);
      if (run.finishedAt) {
        const finished = parseInt(run.finishedAt, 10);
        setDurationText(formatDuration(start, finished));
      } else {
        setDurationText(formatDuration(start));
      }
    };

    updateDuration();

    if (!run.finishedAt) {
      const intervalId = setInterval(updateDuration, 1000);
      return () => clearInterval(intervalId);
    }

    return undefined;
  }, [run.startedAt, run.finishedAt]);

  // Helper to format validation commands summary
  const formatValidationSummary = (validationStatus: string | null | undefined, validationCommands: { command: string; status: string }[] | null | undefined): string => {
    const commands = validationCommands ?? [];
    if (!commands.length) return `${validationStatus ?? 'unknown'} (no commands)`;

    const passed = commands.filter(cmd => cmd.status === 'passed').length;
    const failed = commands.filter(cmd => cmd.status === 'failed').length;
    const running = commands.filter(cmd => cmd.status === 'running').length;
    const pending = commands.filter(cmd => cmd.status === 'pending').length;

    const statusParts: string[] = [];
    if (passed > 0) statusParts.push(`${passed} passed`);
    if (failed > 0) statusParts.push(`${failed} failed`);
    if (running > 0) statusParts.push(`${running} running`);
    if (pending > 0) statusParts.push(`${pending} pending`);

    const statusSummary = statusParts.length ? ` (${statusParts.join(', ')})` : '';
    const commandList = commands.map(cmd => cmd.command).slice(0, 3).join(', ');
    const moreCount = commands.length > 3 ? ` +${commands.length - 3} more` : '';

    return `${validationStatus ?? 'unknown'}${statusSummary}: ${commandList}${moreCount}`;
  };

  return <article className="run-card"><span className={`run-status status status-${run.status}`}>{run.status}</span><header className="run-card-header"><div className="run-header-title"><strong>Run {run.id.slice(0, 8)}</strong>{canCancelRun(run.status) && <button className="run-header-candidate" type="button" disabled={cancelPending} onClick={() => void cancel()}>{cancelPending ? 'Cancellation requested…' : 'Cancel Run'}</button>}{run.status === 'completed' && run.candidatePublishState !== 'published' && <button className="run-header-candidate" type="button" onClick={() => action(window.nightShift.runs.publishCandidate(run.id))}>Publish Candidate</button>}</div><div className="run-header-actions">{([['explorer', assets.explorerButton], ['ide', assets.ideButton], ['terminal', assets.terminalButton]] as const).map(([tool, icon]) => <button type="button" title={tool} key={tool} onClick={() => open(tool)}><img src={icon} alt="" /></button>)}</div></header>{/* Execution Summary */}<div className="run-execution-summary"><div className="summary-grid"><div className="summary-item"><span className="summary-label">Task</span><span className="summary-value">{task?.title ?? 'No task'}</span></div><div className="summary-item"><span className="summary-label">Status</span><span className="summary-value">{run.status}</span></div><div className="summary-item"><span className="summary-label">Agent</span><span className="summary-value">{run.resolvedAgentId}</span></div><div className="summary-item"><span className="summary-label">Model</span><span className="summary-value">{run.resolvedModelId}</span></div><div className="summary-item"><span className="summary-label">Duration</span><span className="summary-value">{durationText}</span></div><div className="summary-item"><span className="summary-label">Validation</span><span className="summary-value">{formatValidationSummary(review.validationStatus, review.validationCommands)}</span></div>{run.candidatePublishState !== 'not_published' && <div className="summary-item"><span className="summary-label">Candidate</span><span className="summary-value">{run.candidatePublishState}{run.candidateCommitSha ? ` ${run.candidateCommitSha.slice(0, 7)}` : ''}</span></div>}{integration && <div className="summary-item"><span className="summary-label">Reviewer</span><span className="summary-value">{integration.verdict} · {integration.integrationStatus}</span></div>}</div></div><div className="run-metadata"><span><b>Mode</b> {run.executionMode}</span><span><b>Agent</b> {run.resolvedAgentId}</span><span><b>Model</b> {run.resolvedModelId}</span></div><button className="run-expand" type="button" onClick={() => setExpanded((value) => !value)}>Afficher {expanded ? 'moins' : 'plus'}</button>{expanded && <Advanced run={run} review={review} integration={integration} action={action} onFollowUpCreated={onFollowUpCreated} onError={onError} />}<nav className="run-tabs">{tabs.map(([value, label]) => <button type="button" className={tab === value ? 'is-active' : ''} onClick={() => { setTab(value); setPath(null); setDiff(''); setEvents(null); }} key={value}>{label}</button>)}</nav>{tab === 'prompt' && <PromptResult task={task} run={run} review={review} />}{tab === 'changes' && <Changes review={review} path={path} diff={diff} onSelect={loadDiff} />}{streamFor(tab) && <EventList page={events} cursor={cursor} onNext={() => events?.nextCursor !== null && events?.nextCursor !== undefined && loadEvents(events.nextCursor)} onFirst={() => loadEvents(null)} />}</article>;
};
const PromptResult = ({ task, run, review }: { task: PlannerTask | null; run: Run; review: RunReview }) => <div className="run-prompt-result"><div className="run-exports">{(['markdown', 'json', 'bundle'] as const).map((kind) => <button type="button" onClick={() => void window.nightShift.runs.exportReview(run.id, kind)} key={kind}>Export {kind === 'bundle' ? 'ZIP' : kind}</button>)}</div><h2>Prompt</h2><pre>{task?.prompt ?? 'Le prompt de la tâche associée n’est plus disponible.'}</pre>{run.followUpPrompt && <><h2>Follow-up</h2><pre>{run.followUpPrompt}</pre></>}<h2>{review.failure ? 'Échec' : 'Résultat'}</h2><pre>{review.failure ?? review.result ?? 'Aucun résumé d’exécution disponible.'}</pre></div>;
const Changes = ({ review, path, diff, onSelect }: { review: RunReview; path: string | null; diff: string; onSelect: (path: string) => void }) => <div className="run-changes">{review.changedFiles.length ? review.changedFiles.map((file) => <button className={path === file.path ? 'is-selected' : ''} type="button" key={file.path} onClick={() => onSelect(file.path)}><span className="file-kind">{extension(file.path)}</span><span className="file-path">{file.path}</span><span className="file-stats">{file.additions !== null && <i>+{file.additions}</i>} {file.deletions !== null && <em>-{file.deletions}</em>}</span><small>{file.note}</small></button>) : <p className="inline-status">Aucun changement détecté.</p>}<pre className="run-diff">{diff || 'Sélectionnez un fichier pour afficher son diff base-relative.'}</pre></div>;
const Advanced = ({ run, review, integration, action, onFollowUpCreated, onError }: { run: Run; review: RunReview; integration: RunIntegrationReview | null; action: (operation: Promise<unknown>) => void; onFollowUpCreated: (run: Run) => Promise<void>; onError: (message: string) => void }) => {
  const [followUpOpen, setFollowUpOpen] = useState(false); const [followUpPrompt, setFollowUpPrompt] = useState(''); const [followUpSubmitting, setFollowUpSubmitting] = useState(false);
  const createFollowUp = async (): Promise<void> => { const prompt = normalizeFollowUpPrompt(followUpPrompt); if (!prompt || followUpSubmitting) return; setFollowUpSubmitting(true); try { const followUp = await window.nightShift.runs.createFollowUp(run.id, prompt); setFollowUpOpen(false); setFollowUpPrompt(''); await onFollowUpCreated(followUp); } catch (error) { onError(message(error)); } finally { setFollowUpSubmitting(false); } };
  return <section className="run-advanced"><div className="run-advanced-metadata"><dl><dt>Session</dt><dd>{run.externalSessionId ?? '—'}</dd><dt>Base SHA</dt><dd>{run.baseSha ?? '—'}</dd><dt>Worktree HEAD</dt><dd>{review.worktreeHead ?? run.finalHeadSha ?? '—'}</dd></dl><dl><dt>Validation</dt><dd>{review.validationStatus ?? '—'}</dd><dt>Candidate</dt><dd>{run.candidatePublishState} {run.candidateCommitSha ?? ''}</dd>{run.candidateFailureReason && <><dt>Publication</dt><dd>{run.candidateFailureReason}</dd></>}</dl></div><div className="run-actions">{run.status === 'cancel_requested' && <span>Cancellation requested…</span>}{run.status === 'completed' && run.candidatePublishState === 'published' && <button type="button" onClick={() => setFollowUpOpen(true)} disabled={followUpSubmitting}>Follow-up Run</button>}{integration ? <><span>{integration.verdict} · {integration.summary}</span>{integration.verdict === 'PASS' && !integration.staleAt && integration.integrationStatus === 'not_started' && <button type="button" onClick={() => action(window.nightShift.runs.integrateReview(integration.id))}>Integrate PASS review</button>}</> : run.candidatePublishState === 'published' && review.validationStatus === 'passed' && <button type="button" onClick={() => action(window.nightShift.runs.requestReview(run.id))}>Request review</button>}</div>{followUpOpen && <form className="follow-up-composer" onSubmit={(event) => { event.preventDefault(); void createFollowUp(); }}><textarea value={followUpPrompt} disabled={followUpSubmitting} onChange={(event) => setFollowUpPrompt(event.target.value)} placeholder="Describe the corrective follow-up work…" aria-label="Corrective prompt" /><div className="run-actions"><button type="button" disabled={followUpSubmitting} onClick={() => { setFollowUpOpen(false); setFollowUpPrompt(''); }}>Cancel</button><button type="submit" disabled={followUpSubmitting || !normalizeFollowUpPrompt(followUpPrompt)}>{followUpSubmitting ? 'Creating…' : 'Create Follow-up'}</button></div></form>}{review.validationCommands.map((command) => <p key={command.id}>Validation {command.status}: {command.command}</p>)}{review.batchSteps.map((step) => <p key={step.id}>Étape {step.stepIndex + 1} · {step.status}: {step.prompt}</p>)}{review.warnings.map((warning) => <p className="run-warning" key={warning}>{warning}</p>)}</section>;
};
const EventList = ({ page, cursor, onNext, onFirst }: { page: RunEventPage | null; cursor: number | null; onNext: () => void; onFirst: () => void }) => <div className="run-events">{page ? <><p className="inline-status">{page.total} events · {cursor === null ? 'première page' : 'page suivante'}</p>{page.events.map((event) => <p key={event.id}><time>{new Date(event.timestamp).toLocaleTimeString()}</time> <strong>{event.eventType}</strong> {JSON.stringify(event.payload)}</p>)}<div className="run-actions">{cursor !== null && <button type="button" onClick={onFirst}>Première page</button>}{page.nextCursor !== null && <button type="button" onClick={onNext}>Suivante</button>}</div></> : <p className="inline-status">Chargement des événements…</p>}</div>;
const extension = (path: string): string => path.split('.').at(-1)?.slice(0, 4).toUpperCase() ?? 'FILE';
const message = (error: unknown): string => error instanceof Error ? error.message : 'NightShift could not load Run details.';