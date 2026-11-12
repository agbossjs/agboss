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
