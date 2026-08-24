import type { DatabaseService } from '../DatabaseService';

interface SettingRow {
  value_json: string;
}

export class SettingsRepository {
  public constructor(private readonly database: DatabaseService) {}

  public get<Value>(key: string): Value | undefined {
    const row = this.database.queryOne<SettingRow>('SELECT value_json FROM app_settings WHERE key = ?', key);
    return row ? (JSON.parse(row.value_json) as Value) : undefined;
  }

  public set<Value>(key: string, value: Value): void {
    this.database.execute(
      `INSERT INTO app_settings(key, value_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      key,
      JSON.stringify(value),
      new Date().toISOString(),
    );
  }
}
