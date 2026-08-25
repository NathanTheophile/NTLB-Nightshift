import type { WorkspaceTool } from '@shared/contracts/ipc';
import { projectQuickActionTools } from '@shared/domain/projectQuickActions';

import { assets } from '../assets';

interface QuickActionsProps {
  disabled: boolean;
  ideDisplayName: string | null;
  onLaunch: (tool: WorkspaceTool) => void;
}

export const QuickActions = ({ disabled, ideDisplayName, onLaunch }: QuickActionsProps) => {
  const actions: Readonly<Record<WorkspaceTool, { label: string; asset: string }>> = {
    terminal: { label: 'Terminal', asset: assets.terminalButton },
    explorer: { label: 'Explorateur Windows', asset: assets.explorerButton },
    ide: {
      label: ideDisplayName ? `Ouvrir dans ${ideDisplayName}` : 'Configurer l’IDE dans Paramètres',
      asset: assets.ideButton,
    },
  };

  return (
    <div className="quick-actions">
      {projectQuickActionTools.map((tool) => (
        <button
          type="button"
          key={tool}
          disabled={disabled}
          title={actions[tool].label}
          onClick={() => onLaunch(tool)}
        >
          <img src={actions[tool].asset} alt="" />
          <span>{actions[tool].label}</span>
        </button>
      ))}
    </div>
  );
};
