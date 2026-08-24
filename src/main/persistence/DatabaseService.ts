import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import { migrations } from './migrations';

interface MigrationRow {
  version: number;
}

export interface DatabaseRunResult {
  changes: number;
}

export class DatabaseService {
  private readonly database: DatabaseSync;

  public constructor(databasePath: string) {
    if (databasePath !== ':memory:') {
      mkdirSync(dirname(databasePath), { recursive: true });
    }

    this.database = new DatabaseSync(databasePath);
    this.database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

    if (databasePath !== ':memory:') {
      this.database.exec('PRAGMA journal_mode = WAL;');
    }

    this.applyMigrations();
  }

  public queryAll<Row>(sql: string, ...parameters: SQLInputValue[]): Row[] {
    return this.database.prepare(sql).all(...parameters) as Row[];
  }

  public queryOne<Row>(sql: string, ...parameters: SQLInputValue[]): Row | undefined {
    return this.database.prepare(sql).get(...parameters) as Row | undefined;
  }

  public execute(sql: string, ...parameters: SQLInputValue[]): DatabaseRunResult {
    const result = this.database.prepare(sql).run(...parameters);
    return { changes: Number(result.changes) };
  }

  public close(): void {
    this.database.close();
  }

  public schemaVersion(): number {
    return this.queryOne<{ version: number }>('SELECT MAX(version) AS version FROM schema_migrations')?.version ?? 0;
  }

  private applyMigrations(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);

    const applied = new Set(
      this.queryAll<MigrationRow>('SELECT version FROM schema_migrations ORDER BY version').map(({ version }) => version),
    );

    for (const migration of migrations) {
      if (applied.has(migration.version)) {
        continue;
      }

      this.database.exec('BEGIN IMMEDIATE;');
      try {
        this.database.exec(migration.sql);
        this.execute(
          'INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)',
          migration.version,
          migration.name,
          new Date().toISOString(),
        );
        this.database.exec('COMMIT;');
      } catch (error) {
        this.database.exec('ROLLBACK;');
        throw error;
      }
    }
  }
}
