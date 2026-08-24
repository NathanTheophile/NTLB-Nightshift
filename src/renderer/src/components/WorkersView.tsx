import { EmptyState } from './EmptyState';

export const WorkersView = () => (
  <section className="conversation-view">
    <div className="conversation-canvas">
      <EmptyState
        eyebrow="WORKERS"
        title="Aucune conversation de code"
        detail="La création et l’exécution des Workers seront reliées après validation du premier adaptateur FCC. Aucun message agent n’est simulé ici."
      />
    </div>
    <div className="worker-composer is-disabled" aria-disabled="true">
      <div className="worker-locked-fields">
        <span>Agent · aucun validé</span>
        <span>Modèle · FCC non connecté</span>
        <span>Accès · à configurer</span>
      </div>
      <textarea disabled placeholder="Le runtime Worker n’est pas encore connecté…" />
    </div>
  </section>
);
