import { assets } from '../assets';

export type AppSection = 'planner' | 'runs' | 'workers' | 'chats' | 'gpt';

interface SidebarProps {
  activeSection: AppSection;
  hasWorkspace: boolean;
  onSelect: (section: AppSection) => void;
}

const navigationItems: ReadonlyArray<{ id: AppSection; label: string; icon: string }> = [
  { id: 'planner', label: 'Planner', icon: assets.plannerIcon },
  { id: 'runs', label: 'Runs', icon: assets.runsIcon },
  { id: 'workers', label: 'Workers', icon: assets.workersIcon },
  { id: 'chats', label: 'Chats', icon: assets.chatsIcon },
  { id: 'gpt', label: 'GPT', icon: assets.gptIcon },
];

export const Sidebar = ({ activeSection, hasWorkspace, onSelect }: SidebarProps) => (
  <aside className="sidebar">
    <nav className="primary-navigation" aria-label="Navigation NightShift">
      {navigationItems.map((item) => (
        <button
          className={`navigation-item ${activeSection === item.id ? 'is-active' : ''}`}
          type="button"
          key={item.id}
          onClick={() => onSelect(item.id)}
        >
          <img src={item.icon} alt="" />
          <span>{item.label}</span>
        </button>
      ))}
    </nav>
    <div className="sidebar-context">
      <span className="context-kicker">CONTEXTE PROJET</span>
      <p>{hasWorkspace ? 'Les vues suivent le projet actif.' : 'Ouvrez un dossier pour commencer.'}</p>
    </div>
  </aside>
);
