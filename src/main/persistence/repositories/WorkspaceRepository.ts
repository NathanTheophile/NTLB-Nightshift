import { randomUUID } from 'node:crypto';

import type { Workspace } from '@shared/domain/entities';

import type { DatabaseService } from '../DatabaseService';

interface WorkspaceRow {
  id: string;
  root_path: string;
  display_name: string;
  is_git: number;
  created_at: string;
  last_opened_at: string;
}

export class WorkspaceRepository {
  public constructor(private readonly database: DatabaseService) {}

  public list(): Workspace[] {
    return this.database
      .queryAll<WorkspaceRow>('SELECT * FROM workspaces ORDER BY last_opened_at DESC')
      .map(mapWorkspace);
  }

  public findById(id: string): Workspace | undefined {
    const row = this.database.queryOne<WorkspaceRow>('SELECT * FROM workspaces WHERE id = ?', id);
    return row ? mapWorkspace(row) : undefined;
  }

  public addOrTouch(rootPath: string, displayName: string, isGit: boolean): Workspace {
    const existing = this.database.queryOne<WorkspaceRow>('SELECT * FROM workspaces WHERE root_path = ?', rootPath);
    const now = new Date().toISOString();

    if (existing) {
      this.database.execute(
        `UPDATE workspaces
         SET display_name = ?, is_git = ?, last_opened_at = ?
         WHERE id = ?`,
        displayName,
        Number(isGit),
        now,
        existing.id,
      );
      return this.findRequired(existing.id);
    }

    const id = randomUUID();
    this.database.execute(
      `INSERT INTO workspaces(id, root_path, display_name, is_git, created_at, last_opened_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      rootPath,
      displayName,
      Number(isGit),
      now,
      now,
    );
    return this.findRequired(id);
  }

  private findRequired(id: string): Workspace {
    const workspace = this.findById(id);
    if (!workspace) {
      throw new Error(`Workspace ${id} was not persisted.`);
    }
    return workspace;
  }
}

const mapWorkspace = (row: WorkspaceRow): Workspace => ({
  id: row.id,
  rootPath: row.root_path,
  displayName: row.display_name,
  isGit: row.is_git === 1,
  createdAt: row.created_at,
  lastOpenedAt: row.last_opened_at,
});
