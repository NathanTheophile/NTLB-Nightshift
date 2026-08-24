import type { AppSection } from './Sidebar';
import { EmptyState } from './EmptyState';

const content: Readonly<Record<Exclude<AppSection, 'planner' | 'workers'>, { eyebrow: string; title: string; detail: string }>> = {
  runs: {
    eyebrow: 'RUNS',
    title: 'Aucune tentative enregistrée',
    detail: 'Les Runs apparaîtront ici lorsque le premier vertical slice Task → worktree → FCC sera implémenté.',
  },
  chats: {
    eyebrow: 'CHATS',
    title: 'Aucune discussion projet',
    detail: 'Les Chats read-only via FCC sont prévus après le cœur Planner / Runs / Workers.',
  },
  gpt: {
    eyebrow: 'GPT',
    title: 'Espace ChatGPT différé',
    detail: 'L’intégration WebContentsView isolée est conservée dans l’architecture, après le vertical slice agentique principal.',
  },
};

export const PlaceholderView = ({ section }: { section: Exclude<AppSection, 'planner' | 'workers'> }) => (
  <section className="placeholder-view">
    <EmptyState {...content[section]} />
  </section>
);
