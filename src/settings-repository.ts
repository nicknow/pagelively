/**
 * 0003 — D1 settings repository (key-value store).
 *
 * Provides typed get/set access to user-configurable settings stored in the
 * `settings` table. All values are stored and returned as strings.
 */
export interface SettingsRepository {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  getAll(): Promise<Record<string, string>>;
}

export function createSettingsRepository(db: D1Database): SettingsRepository {
  return {
    async get(key: string): Promise<string | null> {
      const row = await db
        .prepare("SELECT value FROM settings WHERE key = ?")
        .bind(key)
        .first<{ value: string }>();
      return row?.value ?? null;
    },

    async set(key: string, value: string): Promise<void> {
      await db
        .prepare(
          "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        )
        .bind(key, value)
        .run();
    },

    async getAll(): Promise<Record<string, string>> {
      const result = await db
        .prepare("SELECT key, value FROM settings")
        .all<{ key: string; value: string }>();
      const settings: Record<string, string> = {};
      for (const row of result.results) {
        settings[row.key] = row.value;
      }
      return settings;
    },
  };
}
