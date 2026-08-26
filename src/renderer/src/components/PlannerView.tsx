import { useEffect, useState, type FormEvent } from 'react';

import type { PlannerExecutionMode, PlannerTask, PlannerTaskStatus, Workspace } from '@shared/domain/entities';
import type { PlannerSelectionCatalog } from '@shared/contracts/ipc';

import { assets } from '../assets';
import { EmptyState } from './EmptyState';

interface PlannerViewProps {
  workspace: Workspace;
  onError: (message: string) => void;
}

const statusLabels: Readonly<Record<PlannerTaskStatus, string>> = {
  queued: 'En attente',
  running: 'En cours',
  completed: 'Terminée',
  failed: 'Échouée',
  blocked: 'Bloquée',
  cancelled: 'Annulée',
};

export const PlannerView = ({ workspace, onError }: PlannerViewProps) => {
  const [tasks, setTasks] = useState<PlannerTask[]>([]);
  const [prompt, setPrompt] = useState('');
  const [priority, setPriority] = useState(1);
  const [executionMode, setExecutionMode] = useState<PlannerExecutionMode>('single_agent');
  const [batchSteps, setBatchSteps] = useState<string[]>(['']);
  const [catalog, setCatalog] = useState<PlannerSelectionCatalog | null>(null);
  const [requestedAgentId, setRequestedAgentId] = useState<string | null>(null);
  const [requestedModelId, setRequestedModelId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [concurrency, setConcurrency] = useState<1 | 2 | 3 | 4>(2);
  const [timeoutMs, setTimeoutMs] = useState<1_800_000 | 3_600_000 | 5_400_000 | 7_200_000>(5_400_000);
  const [queuePaused, setQueuePaused] = useState(false);

  useEffect(() => {
    let active = true;
    const refresh = (): void => {
      void window.nightShift.planner.listTasks(workspace.id).then((persistedTasks) => {
        if (active) setTasks(persistedTasks);
      }).catch((error: unknown) => onError(messageFrom(error))).finally(() => { if (active) setLoading(false); });
    };
    refresh();
    void window.nightShift.planner.selectionCatalog().then((value) => {
      if (active) setCatalog(value);
    }).catch((error: unknown) => onError(messageFrom(error)));
    void window.nightShift.planner.getConcurrency().then((value) => {
      if (active) setConcurrency(value.limit);
    }).catch((error: unknown) => onError(messageFrom(error)));
    void window.nightShift.planner.getRunTimeout().then((value) => {
      if (active) setTimeoutMs(value.timeoutMs);
    }).catch((error: unknown) => onError(messageFrom(error)));
    void window.nightShift.planner.getQueueState().then((value) => { if (active) setQueuePaused(value.paused); }).catch((error: unknown) => onError(messageFrom(error)));
    const interval = window.setInterval(refresh, 1_500);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [onError, workspace.id]);

  const submitTask = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (saving || (executionMode === 'single_agent' && !prompt.trim()) || (executionMode === 'sequential_batch' && batchSteps.some((step) => !step.trim()))) {
      return;
    }

    setSaving(true);
    try {
      const task = await window.nightShift.planner.createTask({
        workspaceId: workspace.id,
        prompt,
        requestedAgentId,
        requestedModelId,
        priority,
        executionMode,
        batchSteps: executionMode === 'sequential_batch' ? batchSteps : [],
      });
      setTasks((current) => [...current, task].sort(compareTasks));
      setPrompt('');
      setBatchSteps(['']);
    } catch (error) {
      onError(messageFrom(error));
    } finally {
      setSaving(false);
    }
  };

  const archiveTask = async (taskId: string): Promise<void> => {
    try {
      await window.nightShift.planner.archiveTask(taskId);
      setTasks((current) => current.filter(({ id }) => id !== taskId));
    } catch (error) {
      onError(messageFrom(error));
    }
  };
  const updateConcurrency = async (value: 1 | 2 | 3 | 4): Promise<void> => {
    try { setConcurrency((await window.nightShift.planner.setConcurrency(value)).limit); }
    catch (error) { onError(messageFrom(error)); }
  };
  const updateTimeout = async (value: typeof timeoutMs): Promise<void> => {
    try { setTimeoutMs((await window.nightShift.planner.setRunTimeout(value)).timeoutMs); }
    catch (error) { onError(messageFrom(error)); }
  };
  const updateQueueState = async (): Promise<void> => {
    try { setQueuePaused((await window.nightShift.planner.setQueueState(!queuePaused)).paused); }
    catch (error) { onError(messageFrom(error)); }
  };
  const deleteQueuedTask = async (taskId: string): Promise<void> => {
    try { await window.nightShift.planner.deleteQueuedTask(taskId); setTasks((current) => current.filter((task) => task.id !== taskId)); }
    catch (error) { onError(messageFrom(error)); }
  };
  const updatePriority = async (taskId: string, value: number): Promise<void> => {
    try { const task = await window.nightShift.planner.updateQueuedPriority(taskId, value); setTasks((current) => current.map((item) => item.id === task.id ? task : item).sort(compareTasks)); }
    catch (error) { onError(messageFrom(error)); }
  };
  const purgeTask = async (task: PlannerTask): Promise<void> => {
    const candidate = task.status === 'completed' ? ' Les branches Candidate distantes éventuelles sont conservées.' : '';
    if (!window.confirm(`Supprimer définitivement cette tâche et tout son historique local de Runs ?${candidate}`)) return;
    try { await window.nightShift.planner.purgeTask(task.id); setTasks((current) => current.filter((item) => item.id !== task.id)); }
    catch (error) { onError(messageFrom(error)); }
  };
  const counts = tasks.reduce<Record<string, number>>((value, task) => ({ ...value, [task.status]: (value[task.status] ?? 0) + 1 }), {});

  return (
    <section className="planner-view">
      <div className="planner-queue-status"><strong>{queuePaused ? 'File en pause' : 'File active'}</strong><span>{counts.queued ?? 0} en attente · {counts.running ?? 0} en cours · {counts.completed ?? 0} terminée{(counts.failed ?? 0) + (counts.blocked ?? 0) + (counts.cancelled ?? 0) ? ` · ${(counts.failed ?? 0) + (counts.blocked ?? 0) + (counts.cancelled ?? 0)} en échec/bloquée/annulée` : ''}</span><button type="button" onClick={() => void updateQueueState()}>{queuePaused ? 'Reprendre' : 'Mettre en pause'}</button></div>
      <div className="planner-list" aria-live="polite">
        {loading && <div className="inline-status">Chargement des tâches locales…</div>}
        {!loading && tasks.length === 0 && (
          <EmptyState
            eyebrow="PLANNER LOCAL"
            title="Aucune tâche en attente"
            detail="Créez une intention de travail. NightShift l’exécutera dans un worktree Git isolé."
          />
        )}
        {tasks.map((task, index) => (
          <article className="planner-task" key={task.id}>
            <div className="task-main">
              <div className="task-title-line">
                <span>Tâche {index + 1}</span>
                <strong>{task.title}</strong>
              </div>
              <div className="task-metadata">
                <span>{task.requestedAgentId ? `Agent ${task.requestedAgentId}` : 'Agent Auto'}</span>
                <span>{task.requestedModelId ? `Modèle ${task.requestedModelId}` : 'Modèle Auto'}</span>
                <span>{executionLabel(task.executionMode)}</span>
                <span className={`priority priority-${Math.min(task.priority, 4)}`}>Priorité {task.priority}</span>
                {task.status === 'queued' && <select aria-label={`Priorité de ${task.title}`} value={task.priority} onChange={(event) => void updatePriority(task.id, Number(event.target.value))}>{Array.from({ length: 10 }, (_, index) => index + 1).map((value) => <option key={value} value={value}>{value}</option>)}</select>}
                <span>Persistée localement</span>
              </div>
            </div>
            <div className="task-state">
              <span className={`status status-${task.status}`}>{statusLabels[task.status]}</span>
              <span className="task-time">
                {relativeTime(task.createdAt)}
                <img src={assets.timeIcon} alt="" />
              </span>
            </div>
            {task.status === 'completed' && (
              <button className="archive-task" type="button" title="Archiver la tâche" onClick={() => void archiveTask(task.id)}>
                <img src={assets.deleteButton} alt="" />
              </button>
            )}
            {task.status === 'queued' && <button className="archive-task" type="button" title="Supprimer la tâche en attente" onClick={() => void deleteQueuedTask(task.id)}>Supprimer</button>}
            {(['completed', 'failed', 'blocked', 'cancelled'] as PlannerTaskStatus[]).includes(task.status) && <button className="archive-task" type="button" title="Supprimer définitivement l'historique local" onClick={() => void purgeTask(task)}>Delete</button>}
          </article>
        ))}
      </div>

      <form className="planner-composer" onSubmit={(event) => void submitTask(event)}>
        <div className="planner-fields">
          <label>
            <span>Agent</span>
            <select aria-label="Agent" value={requestedAgentId ?? 'auto'} onChange={(event) => {
              const nextAgentId = event.target.value === 'auto' ? null : event.target.value;
              setRequestedAgentId(nextAgentId);
              setRequestedModelId(null);
            }} disabled={!catalog}>
              <option value="auto">Auto · {catalog?.defaultAgentId ?? 'indisponible'}</option>
              {catalog?.agents.map((agent) => <option value={agent.id} key={agent.id}>{agent.displayName}</option>)}
            </select>
          </label>
          <label>
            <span>Modèle</span>
            <select aria-label="Modèle" value={requestedModelId ?? 'auto'} onChange={(event) => setRequestedModelId(event.target.value === 'auto' ? null : event.target.value)} disabled={!catalog}>
              <option value="auto">Auto · {catalog?.defaultModelId ?? 'indisponible'}</option>
              {availableModels(catalog, requestedAgentId).map((model) => <option value={model.id} key={model.id}>{model.displayName}</option>)}
            </select>
          </label>
          <label>
            <span>Priorité</span>
            <select aria-label="Priorité" value={priority} onChange={(event) => setPriority(Number(event.target.value))}>
              {[1, 2, 3, 4, 5].map((value) => <option value={value} key={value}>{value}</option>)}
            </select>
          </label>
          <label>
            <span>Exécution</span>
            <select aria-label="Mode d’exécution" value={executionMode} onChange={(event) => setExecutionMode(event.target.value as PlannerExecutionMode)}>
              <option value="single_agent">Single Agent</option>
              <option value="sequential_batch">Sequential Batch</option>
            </select>
          </label>
          <label>
            <span>Runs concurrents</span>
            <select aria-label="Runs concurrents" value={concurrency} onChange={(event) => void updateConcurrency(Number(event.target.value) as 1 | 2 | 3 | 4)}>
              {[1, 2, 3, 4].map((value) => <option value={value} key={value}>{value}</option>)}
            </select>
          </label>
          <label>
            <span>Timeout Run</span>
            <select aria-label="Timeout Run" value={timeoutMs} onChange={(event) => void updateTimeout(Number(event.target.value) as typeof timeoutMs)}>
              {[30, 60, 90, 120].map((minutes) => <option value={minutes * 60_000} key={minutes}>{minutes} min</option>)}
            </select>
          </label>
        </div>
        {executionMode === 'sequential_batch' && <div className="batch-editor" aria-label="Étapes du batch séquentiel">
          {batchSteps.map((step, index) => <div className="batch-step" key={index}>
            <span>{index + 1}</span>
            <input value={step} onChange={(event) => setBatchSteps((current) => current.map((item, itemIndex) => itemIndex === index ? event.target.value : item))} placeholder={`Instruction de l’étape ${index + 1}`} aria-label={`Étape ${index + 1}`} />
            <button type="button" onClick={() => setBatchSteps((current) => current.map((item, itemIndex) => itemIndex === index - 1 ? current[index]! : itemIndex === index ? current[index - 1]! : item))} disabled={index === 0}>↑</button>
            <button type="button" onClick={() => setBatchSteps((current) => current.map((item, itemIndex) => itemIndex === index + 1 ? current[index]! : itemIndex === index ? current[index + 1]! : item))} disabled={index === batchSteps.length - 1}>↓</button>
            <button type="button" onClick={() => setBatchSteps((current) => current.length === 1 ? current : current.filter((_, itemIndex) => itemIndex !== index))} disabled={batchSteps.length === 1}>×</button>
          </div>)}
          <button className="batch-add" type="button" onClick={() => setBatchSteps((current) => [...current, ''])} disabled={batchSteps.length >= 32}>Ajouter une étape</button>
        </div>}
        <div className="prompt-field">
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder={executionMode === 'sequential_batch' ? 'Contexte partagé facultatif pour toutes les étapes…' : 'Ajouter une tâche automatisée…'}
            aria-label="Prompt de la tâche Planner"
          />
          <button type="submit" disabled={saving || (executionMode === 'single_agent' && !prompt.trim()) || (executionMode === 'sequential_batch' && batchSteps.some((step) => !step.trim()))}>
            {saving ? 'Enregistrement…' : 'Ajouter à la file'}
          </button>
        </div>
        <p className="runtime-note">Jusqu’à {concurrency} Run{concurrency > 1 ? 's' : ''} Planner isolé{concurrency > 1 ? 's' : ''} s’exécutent simultanément, avec un délai global de {timeoutMs / 60_000} min par Run.</p>
      </form>
    </section>
  );
};

const compareTasks = (left: PlannerTask, right: PlannerTask): number =>
  left.priority - right.priority || left.createdAt.localeCompare(right.createdAt);

const relativeTime = (timestamp: string): string => {
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - new Date(timestamp).getTime()) / 60_000));
  if (elapsedMinutes < 1) return 'maintenant';
  if (elapsedMinutes < 60) return `${elapsedMinutes} min`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  return elapsedHours < 24 ? `${elapsedHours} h` : `${Math.floor(elapsedHours / 24)} j`;
};

const messageFrom = (error: unknown): string =>
  error instanceof Error ? error.message : 'NightShift could not load Planner data.';

const availableModels = (catalog: PlannerSelectionCatalog | null, agentId: string | null) => {
  if (!catalog) return [];
  return catalog.modelsByAgent[agentId ?? catalog.defaultAgentId] ?? [];
};

const executionLabel = (mode: PlannerExecutionMode): string => mode === 'single_agent' ? 'Single Agent' : 'Sequential Batch';
