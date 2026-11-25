import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { StoreError, StoreErrorKind } from "../../core/error-families/store-errors.js";
import { BASELINE_TABLES } from "./sqlite-baseline-schema.js";

/**
 * The schema version of a SQLite file (#1104), kept in the table `agboss_schema` — not in
 * `PRAGMA user_version`, which the turn store already counts its own migrations in on this very file
 * (`src/turns/schema.ts`). `100` is the 0.1.1 baseline (#1321c): the whole schema in one place
 * (`sqlite-baseline-schema.ts`). It is above every number a 0.1.0 or development build ever wrote
 * (`1`, then `2` from #1117; `0` is "no stamp"), so no older stamp can pass for it. Only a file
 * with no table of the baseline is stamped; a 0.1.0 or development file (any older stamp, or
 * tables without one) is refused, never read or migrated — it must be recreated. A build opening a
 * file stamped above its own refuses it (`StoreError.SchemaTooNew`) before it writes a row — what
 * `StoreError.SchemaTooNew` does for PostgreSQL.
 */
export const SQLITE_SCHEMA_VERSION = 100;

/**
 * The file was migrated by a newer build of `@agboss/core` than the one running: an application
 * rolled back over a migrated file. Deploy the newer build again — a migration is never rolled back.
 * A `StoreError.SchemaTooNew`: the versions are its details.
 */
function schemaTooNew(applied: number, expected: number): StoreError.SchemaTooNew {
  return StoreError.of(StoreErrorKind.SchemaTooNew, {
    message: `the SQLite file is at schema version ${String(applied)}, newer than this build's ${String(expected)}: a newer @agboss/core migrated it — deploy that version, a migration is not rolled back`,
    details: { applied, expected },
  });
}

export const SCHEMA_TABLE = "agboss_schema";

const STAMP_TABLE = `CREATE TABLE IF NOT EXISTS ${SCHEMA_TABLE} (
  id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);`;

const VersionRow = z.looseObject({ version: z.number() });

/** The stamp of the file: 0 when it has none (a 0.1.0 file, or a new one — told apart by its tables). */
export function stampOf(database: DatabaseSync): number {
  const table = database
    .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(SCHEMA_TABLE);
  if (table === undefined) return 0;
  const row = database.prepare(`SELECT version FROM ${SCHEMA_TABLE} WHERE id = 1`).get();
  return row === undefined ? 0 : VersionRow.parse(row).version;
}

/** The refusal of a file that predates the 0.1.1 baseline: no stamp, or an older one, beside tables. Names no value of the file. */
function predatesBaseline(): StoreError.SchemaMissing {
  return StoreError.of(StoreErrorKind.SchemaMissing, {
    message:
      "the SQLite file predates the 0.1.1 schema (it is not stamped as the 0.1.1 baseline): it is not read or migrated — recreate the file",
  });
}

/** Whether the file already holds a table of the baseline. */
function holdsAgbossTables(database: DatabaseSync): boolean {
  const names = BASELINE_TABLES;
  const found = database
    .prepare(
      `SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name IN (${names.map(() => "?").join(",")}) LIMIT 1`,
    )
    .get(...names);
  return found !== undefined;
}

/**
 * At open: a file of a newer version is refused, and so is every file that predates this baseline
 * (an older stamp, or agboss tables with no stamp — fail-closed, `StoreError.SchemaMissing`); a
 * file with no table of the baseline is new and is stamped with this build's. A current file is
 * only read (no write lock), and the database is closed when it is refused; the stamp is set inside
 * `BEGIN IMMEDIATE` after reading again, so two builds racing neither lower a stamp nor miss a newer
 * one. The stamp comes before the baseline DDL, which is keyed by the file's shape, never by the
 * stamp, so a crash between them is finished by the next open.
 */
export function checkedSchemaVersion(database: DatabaseSync): void {
  try {
    stampedOrRefused(database);
  } catch (error) {
    database.close();
    throw error;
  }
}

function stampedOrRefused(database: DatabaseSync): void {
  const seen = stampOf(database);
  if (seen === SQLITE_SCHEMA_VERSION) return;
  if (seen > SQLITE_SCHEMA_VERSION) throw schemaTooNew(seen, SQLITE_SCHEMA_VERSION);
  database.exec("BEGIN IMMEDIATE");
  try {
    const applied = stampOf(database);
    if (applied > SQLITE_SCHEMA_VERSION) throw schemaTooNew(applied, SQLITE_SCHEMA_VERSION);
    if (applied < SQLITE_SCHEMA_VERSION) {
      if (applied !== 0 || holdsAgbossTables(database)) throw predatesBaseline();
      database.exec(STAMP_TABLE);
      database
        .prepare(`INSERT OR REPLACE INTO ${SCHEMA_TABLE} (id, version) VALUES (1, ?)`)
        .run(SQLITE_SCHEMA_VERSION);
    }
    database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}
