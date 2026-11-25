import type { ResolvedSettings } from "../../storage/settings.js";

/**
 * What `@DatabaseStorage({ driver: SqliteDriver(…) })` resolved to, as the environment's field the
 * connection reads: the driver's `path`. Any other driver is a configuration the SQLite stores
 * cannot run on.
 */
export function sqliteSettingsOf(settings: ResolvedSettings): { readonly sqlitePath: unknown } {
  if (settings.kind !== "sqlite")
    throw new Error(
      `the SQLite stores are on the database storage's ${settings.kind} driver, not SqliteDriver`,
    );
  return { sqlitePath: settings.path };
}
