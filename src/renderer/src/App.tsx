import { useCallback, useEffect, useMemo, useState } from 'react';

import type { LauncherConfiguration, WorkspaceTool } from '@shared/contracts/ipc';
import type { Workspace } from '@shared/domain/entities';

import { assets } from './assets';
import { EmptyState } from './components/EmptyState';
import { PlannerView } from './components/PlannerView';
import { PlaceholderView } from './components/PlaceholderView';
import { QuickActions } from './components/QuickActions';
import { Sidebar, type AppSection } from './components/Sidebar';
import { WindowChrome } from './components/WindowChrome';
import { WorkersView } from './components/WorkersView';
import { WorkspaceExplorer } from './components/WorkspaceExplorer';

const sectionTitles: Readonly<Record<AppSection, string>> = {
  planner: 'Planner',
  runs: 'Runs',
  workers: 'Workers',
  chats: 'Chats',
  gpt: 'GPT',
};

export const App = () => {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<AppSection>('planner');
  const [launcherConfiguration, setLauncherConfiguration] = useState<LauncherConfiguration>({
    ideConfigured: false,
    ideDisplayName: null,
  });
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const reportError = useCallback((message: string) => setErrorMessage(message), []);

  useEffect(() => {
    void window.nightShift.app
      .bootstrap()
      .then((bootstrap) => {
        setWorkspaces(bootstrap.workspaces);
        setActiveWorkspaceId(bootstrap.workspaces[0]?.id ?? null);
        setLauncherConfiguration(bootstrap.launcherConfiguration);
      })
      .catch((error: unknown) => reportError(messageFrom(error)))
      .finally(() => setLoading(false));
  }, [reportError]);

  const activeWorkspace = useMemo(
    () => workspaces.find(({ id }) => id === activeWorkspaceId) ?? null,
    [activeWorkspaceId, workspaces],
  );

  const openWorkspace = async (): Promise<void> => {
    try {
      const workspace = await window.nightShift.workspace.select();
      if (!workspace) return;
      setWorkspaces((current) => [workspace, ...current.filter(({ id }) => id !== workspace.id)]);
      setActiveWorkspaceId(workspace.id);
    } catch (error) {
      reportError(messageFrom(error));
    }
  };

  const launchWorkspaceTool = async (tool: WorkspaceTool): Promise<void> => {
    if (!activeWorkspace) return;
    try {
      const result = await window.nightShift.launcher.openWorkspaceTool({
        workspaceId: activeWorkspace.id,
        tool,
      });
      if (result.status === 'configuration_required' && tool === 'ide') {
        const configuration = await window.nightShift.launcher.configureIde();
        setLauncherConfiguration(configuration);
        if (configuration.ideConfigured) {
          await window.nightShift.launcher.openWorkspaceTool({ workspaceId: activeWorkspace.id, tool: 'ide' });
        }
      }
    } catch (error) {
      reportError(messageFrom(error));
    }
  };

  const activeTitle = activeWorkspace
    ? `${sectionTitles[activeSection]} · ${activeWorkspace.displayName}`
    : sectionTitles[activeSection];

  return (
    <div className="app-shell" style={{ '--nightshift-background': `url(${assets.background})` } as React.CSSProperties}>
      <WindowChrome
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        onActivateWorkspace={setActiveWorkspaceId}
        onOpenWorkspace={() => void openWorkspace()}
        onHome={() => setActiveSection('planner')}
      />

      <div className="tool-strip">
        <QuickActions disabled={!activeWorkspace} onLaunch={(tool) => void launchWorkspaceTool(tool)} />
        <h1>{activeTitle}</h1>
        <div className="active-project-meta">
          {activeWorkspace && <span>{activeWorkspace.isGit ? 'Dépôt Git' : 'Projet non-Git'}</span>}
          {launcherConfiguration.ideConfigured && <span>IDE · {launcherConfiguration.ideDisplayName}</span>}
        </div>
      </div>

      <div className="workspace-layout">
        <Sidebar
          activeSection={activeSection}
          hasWorkspace={Boolean(activeWorkspace)}
          onSelect={setActiveSection}
        />
        <main className="central-workspace">
          {loading ? (
            <div className="boot-status">Initialisation de NightShift…</div>
          ) : !activeWorkspace ? (
            <EmptyState
              eyebrow="NIGHTSHIFT V2"
              title="Ouvrez votre premier projet"
              detail="Le dossier choisi devient le contexte commun du Planner, des Runs, Workers, Chats et de l’explorateur local."
              actionLabel="Ouvrir un dossier"
              onAction={() => void openWorkspace()}
            />
          ) : activeSection === 'planner' ? (
            <PlannerView key={activeWorkspace.id} workspace={activeWorkspace} onError={reportError} />
          ) : activeSection === 'workers' ? (
            <WorkersView />
          ) : (
            <PlaceholderView section={activeSection} />
          )}
        </main>
        <WorkspaceExplorer workspace={activeWorkspace} onError={reportError} />
      </div>

      {errorMessage && (
        <div className="error-toast" role="alert">
          <div>
            <strong>NightShift n’a pas pu terminer l’action</strong>
            <span>{errorMessage}</span>
          </div>
          <button type="button" onClick={() => setErrorMessage(null)}>Fermer</button>
        </div>
      )}
    </div>
  );
};

const messageFrom = (error: unknown): string =>
  error instanceof Error ? error.message : 'NightShift encountered an unexpected error.';
