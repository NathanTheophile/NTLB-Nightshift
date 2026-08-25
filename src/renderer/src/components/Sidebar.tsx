import { useState } from 'react';
import type { RunNavigationItem } from '@shared/contracts/ipc';
import { assets } from '../assets';

export type AppSection = 'planner' | 'runs' | 'workers' | 'chats' | 'gpt';

interface SidebarProps {
  activeSection: AppSection;
  hasWorkspace: boolean;
  onSelect: (section: AppSection) => void;
  runItems: readonly RunNavigationItem[];
  selectedRunId: string | null;
  onSelectRun: (runId: string) => void;
}

const navigationItems: ReadonlyArray<{ id: AppSection; label: string; icon: string }> = [
  { id: 'planner', label: 'Planner', icon: assets.plannerIcon },
  { id: 'runs', label: 'Runs', icon: assets.runsIcon },
  { id: 'workers', label: 'Workers', icon: assets.workersIcon },
  { id: 'chats', label: 'Chats', icon: assets.chatsIcon },
  { id: 'gpt', label: 'GPT', icon: assets.gptIcon },
];

export const Sidebar = ({ activeSection, hasWorkspace, onSelect, runItems, selectedRunId, onSelectRun }: SidebarProps) => (
  <aside className="sidebar">
    <nav className="primary-navigation" aria-label="Navigation NightShift">
      {navigationItems.map((item) => <div className="sidebar-section" key={item.id}><button
          className={`navigation-item ${activeSection === item.id ? 'is-active' : ''}`}
          type="button"
          onClick={() => onSelect(item.id)}
        >
          <img src={item.icon} alt="" />
          <span>{item.label}</span>
        </button>{item.id === 'runs' && activeSection === 'runs' && <SidebarList items={runItems} selectedId={selectedRunId} onSelect={onSelectRun} />}</div>)}
    </nav>
    <div className="sidebar-context">
      <span className="context-kicker">CONTEXTE PROJET</span>
      <p>{hasWorkspace ? 'Les vues suivent le projet actif.' : 'Ouvrez un dossier pour commencer.'}</p>
    </div>
  </aside>
);

const SidebarList = ({ items, selectedId, onSelect }: { items: readonly RunNavigationItem[]; selectedId: string | null; onSelect: (runId: string) => void }) => {
  const [visibleCount, setVisibleCount] = useState(6);
  return <div className="sidebar-run-list">{items.slice(0, visibleCount).map((run) => <button type="button" className={selectedId === run.id ? 'is-selected' : ''} key={run.id} title={run.taskTitle} onClick={() => onSelect(run.id)}><span className={`status-dot status-${run.status}`} /><span>{run.taskTitle}</span><small>Run {run.id.slice(0, 6)}</small></button>)}{items.length > visibleCount && <button className="show-more" type="button" onClick={() => setVisibleCount((count) => count + 6)}>Afficher plus</button>}</div>;
};
