import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { AGBossError, type MessageErrorOptions } from "../core/errors.js";

/**
 * The schema of `SqliteFtsRagSource`'s index file: every chunk and every file mark keyed by its
 * scope (a tenant's, an owner's, a custom one, or the one key of a shared corpus). The index is
 * derived data — the documents are its source — so a file of an older version is rebuilt, never
 * migrated: its tables are dropped and the next retrieval (or `agboss rag index`) indexes again.
 */

/** The version this source writes (`PRAGMA user_version`). */
export const FTS_SCHEMA_VERSION = 2;

/** An index file of a later version than this connector knows: it is never rewritten. */
export class RagIndexVersionError extends AGBossError {
  static override readonly code = "rag.index-version" as const;
  declare readonly code: typeof RagIndexVersionError.code;
  override name = "RagIndexVersionError";

  constructor(options: MessageErrorOptions) {
    super(options.message, options);
  }
}

/** The first Node 22 whose `node:sqlite` carries the FTS5 module (22.13–22.15 do not; #1226). */
export const FTS5_MIN_NODE = "22.16.0";

/** `node:sqlite` of this Node has no FTS5 module: the connector cannot index or search. */
export class RagFts5UnavailableError extends AGBossError {
  static override readonly code = "rag.fts5-unavailable" as const;
  declare readonly code: typeof RagFts5UnavailableError.code;
  override name = "RagFts5UnavailableError";

  constructor(options: MessageErrorOptions) {
    super(options.message, options);
  }
}

/** What the FTS5 probe needs of a database: one way to run SQL (a seam for a fake without FTS5). */
export interface Fts5Probe {
  exec(sql: string): unknown;
}

/**
 * Refuses, with a typed error naming the Node needed, when `node:sqlite` has no FTS5 module —
 * instead of SQLite's "no such module: fts5" at the first query. The probe's table is a temp one
 * (never in the index file, no write lock on it) and is dropped at once.
 */
export function requireFts5(db: Fts5Probe, nodeVersion: string = process.version): void {
  try {
    db.exec("CREATE VIRTUAL TABLE temp.agboss_fts5_probe USING fts5(x)");
  } catch (error) {
    if (!(error instanceof Error) || !/no such module: fts5/i.test(error.message)) throw error;
    throw new RagFts5UnavailableError({
      message: `SqliteFtsRagSource needs SQLite FTS5, which node:sqlite of Node ${nodeVersion} does not have — use Node ${FTS5_MIN_NODE} or later`,
      cause: error,
    });
  }
  db.exec("DROP TABLE temp.agboss_fts5_probe");
}

const Version = z.object({ user_version: z.number() });
const Table = z.object({ name: z.string() });

const CREATE = `CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(scope_id UNINDEXED, source, text);
  CREATE TABLE IF NOT EXISTS files (
    scope_id TEXT NOT NULL,
    source TEXT NOT NULL,
    hash TEXT NOT NULL,
    PRIMARY KEY (scope_id, source)
  );`;

/** Runs `work` in one `BEGIN IMMEDIATE` transaction: all of it, or none of it. */
export function inTransaction(db: DatabaseSync, work: () => void): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    work();
    db.exec("COMMIT");
  } catch (error) {
    // SQLite ends the transaction itself on some errors: a rollback then would mask the cause
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

const tablesOf = (db: DatabaseSync): ReadonlySet<string> =>
  new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => Table.parse(row).name),
  );

/** An older index: its tables go, the documents it was built from are read again. */
function dropOlderIndex(db: DatabaseSync): void {
  const tables = tablesOf(db);
  if (tables.has("files")) db.exec("DROP TABLE files");
  if (tables.has("chunks")) db.exec("DROP TABLE chunks");
}

/** Creates the schema (rebuilding an older index), in one transaction; a later version is refused. */
export function openSchema(db: DatabaseSync): void {
  db.exec("PRAGMA busy_timeout = 5000");
  // a current file is opened without a write lock: a writer of this process may hold it, yielding
  if (Version.parse(db.prepare("PRAGMA user_version").get()).user_version === FTS_SCHEMA_VERSION)
    return;
  inTransaction(db, () => {
    const version = Version.parse(db.prepare("PRAGMA user_version").get()).user_version;
    if (version > FTS_SCHEMA_VERSION) {
      throw new RagIndexVersionError({
        message: `the index file is of version ${String(version)}, this SqliteFtsRagSource knows up to ${String(FTS_SCHEMA_VERSION)} — upgrade @agboss/core, or index into another file`,
      });
    }
    if (version === FTS_SCHEMA_VERSION) return;
    dropOlderIndex(db);
    db.exec(CREATE);
    db.exec(`PRAGMA user_version = ${String(FTS_SCHEMA_VERSION)}`);
  });
}
