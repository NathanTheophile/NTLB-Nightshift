import type { Workspace } from '@shared/domain/entities';

import { assets } from '../assets';

interface WindowChromeProps {
  workspaces: readonly Workspace[];
  activeWorkspaceId: string | null;
  onActivateWorkspace: (workspaceId: string) => void;
  onOpenWorkspace: () => void;
  onHome: () => void;
}

export const WindowChrome = ({
  workspaces,
  activeWorkspaceId,
  onActivateWorkspace,
  onOpenWorkspace,
  onHome,
}: WindowChromeProps) => (
  <header className="window-chrome">
    <div className="title-bar">
      <button className="home-button no-drag" type="button" title="Accueil Planner" onClick={onHome}>
        <img src={assets.homeButton} alt="" />
      </button>
      <nav className="application-menu no-drag" aria-label="Menu application">
        <button type="button" onClick={onOpenWorkspace}>Fichier</button>
        <span>Affichage</span>
        <span>Lancer</span>
      </nav>
      <img className="title-logo" src={assets.logoFull} alt="NightShift" />
      <div className="window-controls no-drag">
        <button type="button" title="Réduire" onClick={() => void window.nightShift.windowControls.minimize()}>
          <img src={assets.minimizeButton} alt="" />
        </button>
        <button type="button" title="Agrandir ou restaurer" onClick={() => void window.nightShift.windowControls.toggleMaximize()}>
          <img src={assets.maximizeButton} alt="" />
        </button>
        <button className="close-control" type="button" title="Fermer" onClick={() => void window.nightShift.windowControls.close()}>
          <img src={assets.closeButton} alt="" />
        </button>
      </div>
    </div>
    <div className="workspace-tabs no-drag" role="tablist" aria-label="Projets ouverts">
      <div className="workspace-tabs-offset" />
      <div className="workspace-tabs-scroll">
        {workspaces.map((workspace) => {
          const isActive = workspace.id === activeWorkspaceId;
          return (
            <button
              className={`workspace-tab ${isActive ? 'is-active' : ''}`}
              type="button"
              role="tab"
              aria-selected={isActive}
              key={workspace.id}
              onClick={() => onActivateWorkspace(workspace.id)}
            >
              <img src={isActive ? assets.activeTab : assets.inactiveTab} alt="" />
              <span>{workspace.displayName}</span>
              {!workspace.isGit && <small>non-Git</small>}
            </button>
          );
        })}
        <button className="add-workspace-tab" type="button" onClick={onOpenWorkspace}>
          Ouvrir un projet
        </button>
      </div>
    </div>
  </header>
);
