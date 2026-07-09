import type { AppDatabase } from "./db.js";
import type { SecretBox } from "./secrets.js";

type SettingRow = {
  key: string;
  value: string;
  secret: 0 | 1;
};

export class SettingsStore {
  constructor(
    private readonly db: AppDatabase,
    private readonly secretBox: SecretBox,
  ) {}

  getString(key: string): string | undefined {
    const row = this.db.prepare("SELECT key, value, secret FROM app_settings WHERE key = ?").get(key) as SettingRow | undefined;
    if (!row) return undefined;
    return row.secret ? this.secretBox.decrypt(row.value) : row.value;
  }

  getJson<T>(key: string, fallback: T): T {
    const value = this.getString(key);
    if (!value) return fallback;
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }

  setString(key: string, value: string, options?: { secret?: boolean }): void {
    const secret = options?.secret ? 1 : 0;
    const storedValue = secret ? this.secretBox.encrypt(value) : value;
    this.db
      .prepare(`
        INSERT INTO app_settings (key, value, secret, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          secret = excluded.secret,
          updated_at = CURRENT_TIMESTAMP
      `)
      .run(key, storedValue, secret);
  }

  setJson(key: string, value: unknown, options?: { secret?: boolean }): void {
    this.setString(key, JSON.stringify(value), options);
  }

  listPublic(): Record<string, unknown> {
    const rows = this.db.prepare("SELECT key, value, secret FROM app_settings ORDER BY key").all() as SettingRow[];
    const output: Record<string, unknown> = {};

    for (const row of rows) {
      if (row.secret) {
        output[row.key] = "configured";
        continue;
      }

      try {
        output[row.key] = JSON.parse(row.value) as unknown;
      } catch {
        output[row.key] = row.value;
      }
    }

    return output;
  }
}
