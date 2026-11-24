/**
 * #1104 (core): a SQLite file carries the schema version of the build that migrated it
 * (`agboss_schema`). An older build opening a newer file fails closed at open, before it
 * writes a row — as `PostgresSchemaTooNewError` does; a build opening an older or unstamped file
 * stamps it. The stamp is the 0.1.1 baseline's (#1321c): no 0.1.0 file is migrated.
 */
import { describe, expect, it } from "vitest";
import { SqliteSchemaTooNewError } from "../../../src/index.js";
import {
  openSqliteDatabase,
  SQLITE_SCHEMA_VERSION,
} from "../../../src/infrastructure/sqlite/sqlite-connection.js";
import { stampOf } from "../../../src/infrastructure/sqlite/sqlite-schema-version.js";
import { SqliteCheckpointSaver } from "../../../src/infrastructure/sqlite/sqlite-checkpoint-saver.js";
import { connectionTo, temporarySqlitePath } from "../contracts/store-kinds.js";

const versionOf = (path: string): number => {
  const database = openSqliteDatabase(path);
  try {
    return stampOf(database);
  } finally {
    database.close();
  }
};

/** What a newer build does: stamps a version above this build's (a plain open does not stamp). */
const stampedNewer = (path: string): void => {
  const newer = openSqliteDatabase(path);
  newer.exec(
    "CREATE TABLE agboss_schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)",
  );
  newer
    .prepare("INSERT INTO agboss_schema (id, version) VALUES (1, ?)")
    .run(SQLITE_SCHEMA_VERSION + 1);
  newer.close();
};

describe("#1104 AC1: the file carries the schema version", () => {
  it("AC1: a new file is stamped at open", () => {
    const path = temporarySqlitePath();
    connectionTo(path);
    expect(versionOf(path)).toBe(SQLITE_SCHEMA_VERSION);
  });

  it("AC1: a file with no stamp gets the baseline's, and its schema is complete at open", () => {
    const path = temporarySqlitePath();
    const bare = openSqliteDatabase(path);
    bare.close();
    expect(versionOf(path)).toBe(0);

    const connection = connectionTo(path);

    expect(versionOf(path)).toBe(SQLITE_SCHEMA_VERSION);
    expect(connection.columnsOf("execution_leases")).toContain("cancel_requested_at");
    expect(connection.columnsOf("checkpoint_writes")).toContain("tenant_id");
  });

  it("AC1: a second open of a stamped file changes nothing", () => {
    const path = temporarySqlitePath();
    connectionTo(path);
    connectionTo(path);
    expect(versionOf(path)).toBe(SQLITE_SCHEMA_VERSION);
  });
});

describe("#1104 AC2: an older build opening a newer file fails closed", () => {
  it("AC2: a file of a newer version is refused at open, with the versions, and left untouched", () => {
    const path = temporarySqlitePath();
    stampedNewer(path);

    let caught: unknown;
    try {
      connectionTo(path);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SqliteSchemaTooNewError);
    expect(caught).toMatchObject({
      code: "sqlite.schema-too-new",
      applied: SQLITE_SCHEMA_VERSION + 1,
      expected: SQLITE_SCHEMA_VERSION,
    });
    expect(versionOf(path)).toBe(SQLITE_SCHEMA_VERSION + 1);
  });

  it("AC2: the refusal comes before any store creates a table", () => {
    const path = temporarySqlitePath();
    stampedNewer(path);

    expect(() => new SqliteCheckpointSaver(connectionTo(path))).toThrow(SqliteSchemaTooNewError);

    const check = openSqliteDatabase(path);
    expect(
      check
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => row.name),
    ).toEqual(["agboss_schema"]);
    check.close();
  });
});
