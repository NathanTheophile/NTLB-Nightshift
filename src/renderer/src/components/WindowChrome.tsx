import { useEffect, useRef, useState } from 'react';

import type { Workspace } from '@shared/domain/entities';

import { assets } from '../assets';

interface WindowChromeProps {
  workspaces: readonly Workspace[];
  activeWorkspaceId: string | null;
  onActivateWorkspace: (workspaceId: string) => void;
  onCloseWorkspace: (workspaceId: string) => void;
  onMoveWorkspace: (draggedWorkspaceId: string, targetWorkspaceId: string) => void;
  onOpenWorkspace: () => void;
  onOpenSettings: () => void;
  onHome: () => void;
}

export const WindowChrome = ({
  workspaces,
  activeWorkspaceId,
  onActivateWorkspace,
  onCloseWorkspace,
  onMoveWorkspace,
  onOpenWorkspace,
  onOpenSettings,
  onHome,
}: WindowChromeProps) => {
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const [draggedWorkspaceId, setDraggedWorkspaceId] = useState<string | null>(null);
  const fileMenuRef = useRef<HTMLDivElement>(null);
  const tabDragMovedRef = useRef(false);

  useEffect(() => {
    if (!fileMenuOpen) return;
    const closeMenu = (event: PointerEvent): void => {
      if (!fileMenuRef.current?.contains(event.target as Node)) setFileMenuOpen(false);
    };
    const closeMenuOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setFileMenuOpen(false);
    };
    document.addEventListener('pointerdown', closeMenu);
    document.addEventListener('keydown', closeMenuOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeMenu);
      document.removeEventListener('keydown', closeMenuOnEscape);
    };
  }, [fileMenuOpen]);

  useEffect(() => {
    if (!draggedWorkspaceId) return;
    const endDrag = (): void => setDraggedWorkspaceId(null);
    document.addEventListener('mouseup', endDrag);
    return () => {
      document.removeEventListener('mouseup', endDrag);
    };
  }, [draggedWorkspaceId]);

  return (
    <header className="window-chrome">
      <div className="title-bar">
        <button className="home-button no-drag" type="button" title="Accueil Planner" onClick={onHome}>
          <img src={assets.homeButton} alt="" />
        </button>
        <nav className="application-menu no-drag" aria-label="Menu application">
          <div className="file-menu" ref={fileMenuRef}>
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={fileMenuOpen}
              onClick={() => setFileMenuOpen((open) => !open)}
            >
              Fichier
            </button>
            {fileMenuOpen && (
              <div className="application-menu-popup" role="menu">
                <button type="button" role="menuitem" onClick={() => { setFileMenuOpen(false); onOpenWorkspace(); }}>
                  Ouvrir un projet
                </button>
                <button type="button" role="menuitem" onClick={() => { setFileMenuOpen(false); onOpenSettings(); }}>
                  Paramètres
                </button>
              </div>
            )}
          </div>
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
              <div
                className={`workspace-tab ${isActive ? 'is-active' : ''} ${draggedWorkspaceId === workspace.id ? 'is-dragging' : ''}`}
                key={workspace.id}
                onMouseEnter={() => {
                  if (draggedWorkspaceId && draggedWorkspaceId !== workspace.id) {
                    tabDragMovedRef.current = true;
                    onMoveWorkspace(draggedWorkspaceId, workspace.id);
                  }
                }}
              >
                <img className="workspace-tab-background" src={isActive ? assets.activeTab : assets.inactiveTab} alt="" />
                <button
                  className="workspace-tab-select"
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onMouseDown={(event) => {
                    if (event.button !== 0) return;
                    tabDragMovedRef.current = false;
                    setDraggedWorkspaceId(workspace.id);
                  }}
                  onClick={() => {
                    if (tabDragMovedRef.current) {
                      tabDragMovedRef.current = false;
                      return;
                    }
                    onActivateWorkspace(workspace.id);
                  }}
                >
                  <span>{workspace.displayName}</span>
                  {!workspace.isGit && <small>non-Git</small>}
                </button>
                <button
                  className="close-workspace-tab"
                  type="button"
                  title={`Fermer ${workspace.displayName}`}
                  aria-label={`Fermer le projet ${workspace.displayName}`}
                  draggable={false}
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={() => onCloseWorkspace(workspace.id)}
                >
                  <img src={assets.deleteButton} alt="" draggable={false} />
                </button>
              </div>
            );
          })}
          <button className="add-workspace-tab" type="button" onClick={onOpenWorkspace}>Ouvrir un projet</button>
        </div>
      </div>
    </header>
  );
};
