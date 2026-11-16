import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { AGBossError, type MessageErrorOptions } from "../core/errors.js";
import { DEFAULT_TENANT_ID } from "../flow/context/tenant-context.js";

/**
 * The schema of `SqliteFtsConnector`'s index file (#700): every chunk and every file mark keyed by
 * its tenant. Version 0 (before #700) kept one index for every tenant; it is migrated in place, its
 * rows kept under the default tenant — what an execution that names no tenant is.
 */

/** The version this connector writes (`PRAGMA user_version`). */
export const FTS_SCHEMA_VERSION = 1;

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
      message: `SqliteFtsConnector needs SQLite FTS5, which node:sqlite of Node ${nodeVersion} does not have — use Node ${FTS5_MIN_NODE} or later`,
      cause: error,
    });
  }
  db.exec("DROP TABLE temp.agboss_fts5_probe");
}

const Version = z.object({ user_version: z.number() });
const Table = z.object({ name: z.string() });

const CREATE = `CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(tenant_id UNINDEXED, source, text);
  CREATE TABLE IF NOT EXISTS files (
    tenant_id TEXT NOT NULL,
    source TEXT NOT NULL,
    hash TEXT NOT NULL,
    PRIMARY KEY (tenant_id, source)
  );`;

/** Runs `work` in one `BEGIN IMMEDIATE` transaction: all of it, or none of it. */
export function inTransaction(db: DatabaseSync, work: () => void): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    work();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
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

/** Version 0 → 1: the tables of one shared index become the default tenant's. */
function migrateFromVersion0(db: DatabaseSync): void {
  db.exec(`ALTER TABLE files RENAME TO files_v0;
    ALTER TABLE chunks RENAME TO chunks_v0;`);
  db.exec(CREATE);
  db.prepare("INSERT INTO files SELECT ?, source, hash FROM files_v0").run(DEFAULT_TENANT_ID);
  db.prepare(
    "INSERT INTO chunks (tenant_id, source, text) SELECT ?, source, text FROM chunks_v0",
  ).run(DEFAULT_TENANT_ID);
  db.exec("DROP TABLE files_v0; DROP TABLE chunks_v0;");
}

/** Creates or migrates the schema, in one transaction; a later version is refused. */
export function openSchema(db: DatabaseSync): void {
  db.exec("PRAGMA busy_timeout = 5000");
  // a current file is opened without a write lock: a writer of this process may hold it, yielding
  if (Version.parse(db.prepare("PRAGMA user_version").get()).user_version === FTS_SCHEMA_VERSION)
    return;
  inTransaction(db, () => {
    const version = Version.parse(db.prepare("PRAGMA user_version").get()).user_version;
    if (version > FTS_SCHEMA_VERSION) {
      throw new RagIndexVersionError({
        message: `the index file is of version ${String(version)}, this SqliteFtsConnector knows up to ${String(FTS_SCHEMA_VERSION)} — upgrade @agboss/core, or index into another file`,
      });
    }
    if (version === FTS_SCHEMA_VERSION) return;
    if (tablesOf(db).has("files")) migrateFromVersion0(db);
    else db.exec(CREATE);
    db.exec(`PRAGMA user_version = ${String(FTS_SCHEMA_VERSION)}`);
  });
}
