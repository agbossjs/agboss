import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { AGBossError, type AGBossErrorOptions } from "../../core/errors.js";

/**
 * The schema version of a SQLite file (#1104), kept in the table `agboss_schema` — not in
 * `PRAGMA user_version`, which the turn store already counts its own migrations in on this very file
 * (`src/turns/schema.ts`). 0.1.0 never stamped: a file with no stamp (0) is a 0.1.0 file (or a new
 * one): this build migrates it and stamps it `1`. A later build that
 * changes the schema raises the number; a build opening a file stamped above its own refuses it
 * (`SqliteSchemaTooNewError`) before it writes a row — what `PostgresSchemaTooNewError` does for
 * PostgreSQL. A 0.1.0 binary never reads the stamp and cannot be refused: stop it before the upgrade.
 */
export const SQLITE_SCHEMA_VERSION = 1;

/** What a refusal knows: the version the file is stamped with and the one this build writes. */
export interface SqliteSchemaTooNewErrorOptions extends AGBossErrorOptions {
  readonly applied: number;
  readonly expected: number;
}

/**
 * The file was migrated by a newer build of `@agboss/core` than the one running: an application
 * rolled back over a migrated file. Deploy the newer build again — a migration is never rolled back.
 */
export class SqliteSchemaTooNewError extends AGBossError {
  static override readonly code = "sqlite.schema-too-new" as const;
  declare readonly code: typeof SqliteSchemaTooNewError.code;
  override name = "SqliteSchemaTooNewError";
  readonly applied: number;
  readonly expected: number;

  constructor(options: SqliteSchemaTooNewErrorOptions) {
    const { applied, expected, ...rest } = options;
    super(
      `the SQLite file is at schema version ${String(applied)}, newer than this build's ${String(expected)}: a newer @agboss/core migrated it — deploy that version, a migration is not rolled back`,
      rest,
    );
    this.applied = applied;
    this.expected = expected;
  }
}

export const SCHEMA_TABLE = "agboss_schema";

const STAMP_TABLE = `CREATE TABLE IF NOT EXISTS ${SCHEMA_TABLE} (
  id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);`;

const VersionRow = z.looseObject({ version: z.number() });

/** The stamp of the file: 0 when it has none (a 0.1.0 file, or a new one). */
export function stampOf(database: DatabaseSync): number {
  const table = database
    .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(SCHEMA_TABLE);
  if (table === undefined) return 0;
  const row = database.prepare(`SELECT version FROM ${SCHEMA_TABLE} WHERE id = 1`).get();
  return row === undefined ? 0 : VersionRow.parse(row).version;
}

/**
 * At open: a file of a newer version is refused, an older or unstamped one is stamped with this
 * build's. A current file is only read (no write lock), and the database is closed when it is refused; the stamp is set inside `BEGIN IMMEDIATE`
 * after reading again, so two builds racing neither lower a stamp nor miss a newer one. The stamp
 * comes before the stores migrate: migrations are keyed by the file's shape, never by the stamp, so
 * a crash between them is finished by the next open.
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
  if (seen > SQLITE_SCHEMA_VERSION)
    throw new SqliteSchemaTooNewError({ applied: seen, expected: SQLITE_SCHEMA_VERSION });
  database.exec("BEGIN IMMEDIATE");
  try {
    const applied = stampOf(database);
    if (applied > SQLITE_SCHEMA_VERSION)
      throw new SqliteSchemaTooNewError({ applied, expected: SQLITE_SCHEMA_VERSION });
    if (applied < SQLITE_SCHEMA_VERSION) {
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
