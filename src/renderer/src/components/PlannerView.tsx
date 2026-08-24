import { useEffect, useState, type FormEvent } from 'react';

import type { PlannerTask, PlannerTaskStatus, Workspace } from '@shared/domain/entities';

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
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    void window.nightShift.planner
      .listTasks(workspace.id)
      .then((persistedTasks) => {
        if (active) {
          setTasks(persistedTasks);
        }
      })
      .catch((error: unknown) => onError(messageFrom(error)))
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [onError, workspace.id]);

  const submitTask = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!prompt.trim() || saving) {
      return;
    }

    setSaving(true);
    try {
      const task = await window.nightShift.planner.createTask({
        workspaceId: workspace.id,
        prompt,
        requestedAgentId: null,
        requestedModelId: null,
        priority,
      });
      setTasks((current) => [...current, task].sort(compareTasks));
      setPrompt('');
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

  return (
    <section className="planner-view">
      <div className="planner-list" aria-live="polite">
        {loading && <div className="inline-status">Chargement des tâches locales…</div>}
        {!loading && tasks.length === 0 && (
          <EmptyState
            eyebrow="PLANNER LOCAL"
            title="Aucune tâche en attente"
            detail="Créez une intention de travail. Elle sera persistée maintenant, mais ne sera pas exécutée avant le prochain jalon FCC / Runs."
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
                <span>Agent Auto</span>
                <span>Modèle Auto</span>
                <span className={`priority priority-${Math.min(task.priority, 4)}`}>Priorité {task.priority}</span>
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
          </article>
        ))}
      </div>

      <form className="planner-composer" onSubmit={(event) => void submitTask(event)}>
        <div className="planner-fields">
          <label>
            <span>Agent</span>
            <select aria-label="Agent" value="auto" disabled>
              <option value="auto">Auto · prochain jalon</option>
            </select>
          </label>
          <label>
            <span>Modèle</span>
            <select aria-label="Modèle" value="auto" disabled>
              <option value="auto">Auto · FCC non connecté</option>
            </select>
          </label>
          <label>
            <span>Priorité</span>
            <select aria-label="Priorité" value={priority} onChange={(event) => setPriority(Number(event.target.value))}>
              {[1, 2, 3, 4, 5].map((value) => <option value={value} key={value}>{value}</option>)}
            </select>
          </label>
        </div>
        <div className="prompt-field">
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Ajouter une tâche automatisée…"
            aria-label="Prompt de la tâche Planner"
          />
          <button type="submit" disabled={!prompt.trim() || saving}>
            {saving ? 'Enregistrement…' : 'Ajouter à la file'}
          </button>
        </div>
        <p className="runtime-note">La file est persistée. Aucun agent ne sera lancé dans ce bootstrap.</p>
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
