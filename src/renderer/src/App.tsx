import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { LauncherConfiguration, RunNavigationItem, WorkspaceTool } from '@shared/contracts/ipc';
import type { Workspace } from '@shared/domain/entities';
import { closeWorkspaceTab, reorderWorkspaceTabs } from '@shared/domain/workspaceTabs';

import { assets } from './assets';
import { EmptyState } from './components/EmptyState';
import { PlannerView } from './components/PlannerView';
import { RunsView } from './components/RunsView';
import { PlaceholderView } from './components/PlaceholderView';
import { QuickActions } from './components/QuickActions';
import { SettingsDialog } from './components/SettingsDialog';
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
  const [runItems, setRunItems] = useState<RunNavigationItem[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const navigationRequest = useRef(0);
  const [launcherConfiguration, setLauncherConfiguration] = useState<LauncherConfiguration>({
    ideConfigured: false,
    ideDisplayName: null,
  });
  const [loading, setLoading] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [configuringIde, setConfiguringIde] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const reportError = useCallback((message: string) => setErrorMessage(message), []);

  useEffect(() => {
    void window.nightShift.app
      .bootstrap()
      .then((bootstrap) => {
        setWorkspaces(bootstrap.workspaces);
        setActiveWorkspaceId(bootstrap.activeWorkspaceId);
        setLauncherConfiguration(bootstrap.launcherConfiguration);
      })
      .catch((error: unknown) => reportError(messageFrom(error)))
      .finally(() => setLoading(false));
  }, [reportError]);

  const activeWorkspace = useMemo(
    () => workspaces.find(({ id }) => id === activeWorkspaceId) ?? null,
    [activeWorkspaceId, workspaces],
  );
  const selectedRun = runItems.find((run) => run.id === selectedRunId) ?? null;
  useEffect(() => {
    const request = ++navigationRequest.current;
    if (!activeWorkspace) return;
    const load = (): void => { void window.nightShift.runs.navigation(activeWorkspace.id).then((items) => { if (navigationRequest.current !== request) return; setRunItems(items); setSelectedRunId((current) => items.some((item) => item.id === current) ? current : items[0]?.id ?? null); }).catch((error: unknown) => { if (navigationRequest.current === request) reportError(messageFrom(error)); }); };
    load(); const timer = window.setInterval(load, 1_500); return () => window.clearInterval(timer);
  }, [activeWorkspace, reportError]);

  const openWorkspace = async (): Promise<void> => {
    try {
      const workspace = await window.nightShift.workspace.select();
      if (!workspace) return;
      const nextWorkspaces = workspaces.some(({ id }) => id === workspace.id)
        ? workspaces
        : [...workspaces, workspace];
      applyTabState(nextWorkspaces, workspace.id);
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
        setSettingsOpen(true);
      }
    } catch (error) {
      reportError(messageFrom(error));
    }
  };

  const applyTabState = (nextWorkspaces: Workspace[], nextActiveWorkspaceId: string | null): void => {
    if (nextActiveWorkspaceId !== activeWorkspaceId) { navigationRequest.current += 1; setRunItems([]); setSelectedRunId(null); }
    setWorkspaces(nextWorkspaces);
    setActiveWorkspaceId(nextActiveWorkspaceId);
    void window.nightShift.workspace.saveTabState({
      workspaceIds: nextWorkspaces.map(({ id }) => id),
      activeWorkspaceId: nextActiveWorkspaceId,
    }).catch((error: unknown) => reportError(messageFrom(error)));
  };

  const activateWorkspace = (workspaceId: string): void => applyTabState(workspaces, workspaceId);

  const closeWorkspace = (workspaceId: string): void => {
    const next = closeWorkspaceTab(workspaces, activeWorkspaceId, workspaceId);
    applyTabState(next.workspaces, next.activeWorkspaceId);
  };

  const moveWorkspace = (draggedWorkspaceId: string, targetWorkspaceId: string): void => {
    applyTabState(
      reorderWorkspaceTabs(workspaces, draggedWorkspaceId, targetWorkspaceId),
      activeWorkspaceId,
    );
  };

  const configureIde = async (): Promise<void> => {
    setConfiguringIde(true);
    try {
      setLauncherConfiguration(await window.nightShift.launcher.configureIde());
    } catch (error) {
      reportError(messageFrom(error));
    } finally {
      setConfiguringIde(false);
    }
  };

  return (
    <div className="app-shell" style={{ '--nightshift-background': `url(${assets.background})` } as React.CSSProperties}>
      <WindowChrome
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        onActivateWorkspace={activateWorkspace}
        onCloseWorkspace={closeWorkspace}
        onMoveWorkspace={moveWorkspace}
        onOpenWorkspace={() => void openWorkspace()}
        onOpenSettings={() => setSettingsOpen(true)}
        onHome={() => setActiveSection('planner')}
      />

      <div className="tool-strip">
        {activeSection !== 'runs' && <QuickActions
          disabled={!activeWorkspace}
          ideDisplayName={launcherConfiguration.ideDisplayName}
          onLaunch={(tool) => void launchWorkspaceTool(tool)}
        />}
        <h1>
          <span className="context-section">{sectionTitles[activeSection]}</span>
          {activeWorkspace && <span className="context-workspace">{activeSection === 'runs' && selectedRun ? ` - ${selectedRun.taskTitle}` : ` · ${activeWorkspace.displayName}`}</span>}
        </h1>
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
          runItems={runItems}
          selectedRunId={selectedRunId}
          onSelectRun={(runId) => { setSelectedRunId(runId); setActiveSection('runs'); }}
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
            <WorkersView key={activeWorkspace.id} workspace={activeWorkspace} onError={reportError} />
          ) : activeSection === 'runs' ? (
            <RunsView key={`${activeWorkspace.id}:${selectedRunId ?? ''}`} workspace={activeWorkspace} selectedRunId={selectedRunId} onSelectRun={setSelectedRunId} onError={reportError} />
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
      {settingsOpen && (
        <SettingsDialog
          configuration={launcherConfiguration}
          configuring={configuringIde}
          onClose={() => setSettingsOpen(false)}
          onConfigureIde={() => void configureIde()}
        />
      )}
    </div>
  );
};

const messageFrom = (error: unknown): string =>
  error instanceof Error ? error.message : 'NightShift encountered an unexpected error.';
