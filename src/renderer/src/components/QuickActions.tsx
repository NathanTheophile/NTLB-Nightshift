import type { WorkspaceTool } from '@shared/contracts/ipc';

import { assets } from '../assets';

interface QuickActionsProps {
  disabled: boolean;
  onLaunch: (tool: WorkspaceTool) => void;
}

const actions: ReadonlyArray<{ tool: WorkspaceTool; label: string; asset: string }> = [
  { tool: 'terminal', label: 'Terminal', asset: assets.terminalButton },
  { tool: 'explorer', label: 'Explorateur Windows', asset: assets.explorerButton },
  { tool: 'ide', label: 'IDE configuré', asset: assets.ideButton },
];

export const QuickActions = ({ disabled, onLaunch }: QuickActionsProps) => (
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
