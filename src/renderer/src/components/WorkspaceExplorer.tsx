import { useEffect, useState } from 'react';

import type { WorkspaceDirectoryPage, WorkspaceEntry } from '@shared/contracts/ipc';
import type { Workspace } from '@shared/domain/entities';

import { assets } from '../assets';

interface WorkspaceExplorerProps {
  workspace: Workspace | null;
  onError: (message: string) => void;
}

interface DirectoryBranchProps {
  workspaceId: string;
  relativePath: string;
  depth: number;
  onError: (message: string) => void;
}

export const WorkspaceExplorer = ({ workspace, onError }: WorkspaceExplorerProps) => (
  <aside className="workspace-explorer">
    <div className="explorer-title-row">
      <span>Explorer</span>
      <img src={assets.explorerIcon} alt="" />
    </div>
    {!workspace ? (
      <p className="explorer-empty">Aucun projet ouvert</p>
    ) : (
      <div className="explorer-tree">
        <div className="explorer-root">
          <img src={assets.folderIcon} alt="" />
          <span title={workspace.rootPath}>{workspace.displayName}</span>
          <small>{workspace.isGit ? 'Git' : 'non-Git'}</small>
        </div>
        <DirectoryBranch key={workspace.id} workspaceId={workspace.id} relativePath="" depth={0} onError={onError} />
      </div>
    )}
  </aside>
);

const DirectoryBranch = ({ workspaceId, relativePath, depth, onError }: DirectoryBranchProps) => {
  const [page, setPage] = useState<WorkspaceDirectoryPage>({ entries: [], nextOffset: null });
  const [loading, setLoading] = useState(true);

  const loadMore = async (offset: number): Promise<void> => {
    try {
      const nextPage = await window.nightShift.workspace.listEntries({
        workspaceId,
        relativePath,
        offset,
        limit: 100,
      });
      setPage((current) => ({
        entries: offset === 0 ? nextPage.entries : [...current.entries, ...nextPage.entries],
        nextOffset: nextPage.nextOffset,
      }));
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Unable to list workspace files.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let active = true;
    void window.nightShift.workspace
      .listEntries({ workspaceId, relativePath, offset: 0, limit: 100 })
      .then((initialPage) => {
        if (active) {
          setPage(initialPage);
        }
      })
      .catch((error: unknown) => onError(error instanceof Error ? error.message : 'Unable to list workspace files.'))
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [onError, relativePath, workspaceId]);

  return (
    <div className="directory-branch">
      {page.entries.map((entry) => (
        <ExplorerEntry
          key={entry.relativePath}
          entry={entry}
          workspaceId={workspaceId}
          depth={depth}
          onError={onError}
        />
      ))}
      {loading && page.entries.length === 0 && <span className="tree-status">Chargement…</span>}
      {page.nextOffset !== null && (
        <button
          className="load-more-files"
          type="button"
          onClick={() => {
            setLoading(true);
            void loadMore(page.nextOffset ?? 0);
          }}
          disabled={loading}
        >
          Afficher la suite
        </button>
      )}
    </div>
  );
};

const ExplorerEntry = ({
  entry,
  workspaceId,
  depth,
  onError,
}: {
  entry: WorkspaceEntry;
  workspaceId: string;
  depth: number;
  onError: (message: string) => void;
}) => {
  const [expanded, setExpanded] = useState(false);
  const isDirectory = entry.kind === 'directory';

  return (
    <div className="tree-entry-wrap">
      <button
        className={`tree-entry tree-entry-${entry.kind}`}
        type="button"
        style={{ paddingLeft: `${12 + depth * 16}px` }}
        disabled={!isDirectory}
        title={entry.relativePath}
        onClick={() => setExpanded((value) => !value)}
      >
        {isDirectory && <span className={`tree-chevron ${expanded ? 'is-expanded' : ''}`}>›</span>}
        {isDirectory && <img src={assets.folderIcon} alt="" />}
        <span>{entry.name}</span>
        {entry.kind === 'symlink' && <small>lien</small>}
      </button>
      {isDirectory && expanded && (
        <DirectoryBranch
          workspaceId={workspaceId}
          relativePath={entry.relativePath}
          depth={depth + 1}
          onError={onError}
        />
      )}
    </div>
  );
};
