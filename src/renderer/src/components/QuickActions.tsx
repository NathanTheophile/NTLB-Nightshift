import type { WorkspaceTool } from '@shared/contracts/ipc';

import { assets } from '../assets';

interface QuickActionsProps {
  disabled: boolean;
  ideDisplayName: string | null;
  onLaunch: (tool: WorkspaceTool) => void;
}

export const QuickActions = ({ disabled, ideDisplayName, onLaunch }: QuickActionsProps) => {
  const actions: ReadonlyArray<{ tool: WorkspaceTool; label: string; asset: string }> = [
    { tool: 'terminal', label: 'Terminal', asset: assets.terminalButton },
    { tool: 'explorer', label: 'Explorateur Windows', asset: assets.explorerButton },
    {
      tool: 'ide',
      label: ideDisplayName ? `Ouvrir dans ${ideDisplayName}` : 'Configurer l’IDE dans Paramètres',
      asset: assets.ideButton,
    },
  ];

  return (
    <div className="quick-actions">
      {actions.map((action) => (
        <button
          type="button"
          key={action.tool}
          disabled={disabled}
          title={action.label}
          onClick={() => onLaunch(action.tool)}
        >
          <img src={action.asset} alt="" />
          <span>{action.label}</span>
        </button>
      ))}
    </div>
  );
};
