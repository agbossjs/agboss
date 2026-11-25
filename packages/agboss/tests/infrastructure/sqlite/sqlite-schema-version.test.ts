/**
 * #1104 (core): a SQLite file carries the schema version of the build that migrated it
 * (`agboss_schema`). An older build opening a newer file fails closed at open, before it
 * writes a row — as `PostgresSchemaTooNewError` does; a build opening an older or unstamped file
 * stamps it. The stamp is the 0.1.1 baseline's (#1321c): no 0.1.0 file is migrated.
 */
import { describe, expect, it } from "vitest";
import { StoreError } from "../../../src/core/error-families/store-errors.js";
import {
  openSqliteDatabase,
  SQLITE_SCHEMA_VERSION,
} from "../../../src/infrastructure/sqlite/sqlite-connection.js";
import {
  BASELINE_TABLES,
  ensureBaselineSchema,
} from "../../../src/infrastructure/sqlite/sqlite-baseline-schema.js";
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

  it("AC1: a file with no table of the baseline and no stamp is new: stamped, its schema complete at open", () => {
    const path = temporarySqlitePath();
    const bare = openSqliteDatabase(path);
    bare.close();
    expect(versionOf(path)).toBe(0);

    const connection = connectionTo(path);

    expect(versionOf(path)).toBe(SQLITE_SCHEMA_VERSION);
    expect(connection.columnsOf("execution_leases")).toContain("cancel_requested_at");
    expect(connection.columnsOf("checkpoint_writes")).toContain("tenant_id");
  });

  it("AC1: a file with an application's own table and no stamp still opens, and the table stays", () => {
    const path = temporarySqlitePath();
    const own = openSqliteDatabase(path);
    own.exec("CREATE TABLE orders (id TEXT PRIMARY KEY, total INTEGER NOT NULL)");
    own.close();

    const connection = connectionTo(path);
    connection.ensureSchema(
      "invoices",
      "CREATE TABLE IF NOT EXISTS invoices (id TEXT PRIMARY KEY)",
    );

    expect(versionOf(path)).toBe(SQLITE_SCHEMA_VERSION);
    expect(connection.columnsOf("orders")).toEqual(["id", "total"]);
    expect(connection.columnsOf("invoices")).toEqual(["id"]);
  });
  it("AC1: the current file reopens", () => {
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

    expect(caught).toBeInstanceOf(StoreError.SchemaTooNew);
    expect(caught).toMatchObject({
      code: "store.schema-too-new",
      details: { applied: SQLITE_SCHEMA_VERSION + 1, expected: SQLITE_SCHEMA_VERSION },
    });
    expect(versionOf(path)).toBe(SQLITE_SCHEMA_VERSION + 1);
  });

  it("AC2: the refusal comes before any store creates a table", () => {
    const path = temporarySqlitePath();
    stampedNewer(path);

    expect(() => new SqliteCheckpointSaver(connectionTo(path))).toThrow(StoreError.SchemaTooNew);

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

/** What the stamp-less 0.1.0 and every development build left: the baseline's tables, or a table of it. */
const refusedAtOpen = (path: string): unknown => {
  try {
    connectionTo(path);
  } catch (error) {
    return error;
  }
  return undefined;
};

const tablesOf = (path: string): readonly string[] => {
  const check = openSqliteDatabase(path);
  try {
    return check
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => String(row.name));
  } finally {
    check.close();
  }
};

describe("#1321c: a file that predates the 0.1.1 baseline is refused, never stamped", () => {
  const refusal = {
    kind: "schema-missing",
    code: "store.schema-missing",
  };

  it("a file with agboss tables and no stamp (a 0.1.0 file) is refused and left unstamped", () => {
    const path = temporarySqlitePath();
    const old = openSqliteDatabase(path);
    old.exec("CREATE TABLE execution_leases (tenant_id TEXT, root_execution_id TEXT)");
    old.close();

    const caught = refusedAtOpen(path);

    expect(caught).toBeInstanceOf(StoreError);
    expect(caught).toBeInstanceOf(StoreError.SchemaMissing);
    expect(caught).toMatchObject(refusal);
    expect(versionOf(path)).toBe(0);
    expect(tablesOf(path)).toEqual(["execution_leases"]);
  });

  it("a file with agboss tables and a stamp of 0 is refused", () => {
    const path = temporarySqlitePath();
    const old = openSqliteDatabase(path);
    old.exec("CREATE TABLE execution_ids (id TEXT)");
    old.exec(
      "CREATE TABLE agboss_schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)",
    );
    old.exec("INSERT INTO agboss_schema (id, version) VALUES (1, 0)");
    old.close();

    expect(refusedAtOpen(path)).toBeInstanceOf(StoreError.SchemaMissing);
    expect(versionOf(path)).toBe(0);
  });

  it.each([1, 2, SQLITE_SCHEMA_VERSION - 1])(
    "a file stamped %i, a version an older build wrote, is refused and its stamp kept",
    (version) => {
      const path = temporarySqlitePath();
      const old = openSqliteDatabase(path);
      old.exec("CREATE TABLE execution_leases (tenant_id TEXT, root_execution_id TEXT)");
      old.exec(
        "CREATE TABLE agboss_schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)",
      );
      old.prepare("INSERT INTO agboss_schema (id, version) VALUES (1, ?)").run(version);
      old.close();

      expect(refusedAtOpen(path)).toBeInstanceOf(StoreError.SchemaMissing);
      expect(versionOf(path)).toBe(version);
    },
  );

  it("the refusal is made in the same way for every table of the baseline", () => {
    for (const table of BASELINE_TABLES) {
      const path = temporarySqlitePath();
      const old = openSqliteDatabase(path);
      old.exec(`CREATE TABLE "${table}" (x TEXT)`);
      old.close();

      expect(refusedAtOpen(path), table).toBeInstanceOf(StoreError.SchemaMissing);
    }
  });

  it("the message says the file predates 0.1.1 and must be recreated, and names no path or stored value", () => {
    const path = temporarySqlitePath();
    const old = openSqliteDatabase(path);
    old.exec("CREATE TABLE execution_leases (tenant_id TEXT, root_execution_id TEXT)");
    old.exec("INSERT INTO execution_leases VALUES ('secret-tenant', 'secret-root')");
    old.close();

    const caught = refusedAtOpen(path);

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain("predates the 0.1.1");
    expect(message).toContain("recreate");
    expect(message).not.toContain("secret");
    expect(message).not.toContain(path);
  });

  it("the stamp number is above every number an earlier build wrote (0 none, 1, 2)", () => {
    expect(SQLITE_SCHEMA_VERSION).toBeGreaterThan(2);
  });
});

describe("#1321c: the list of the baseline's tables", () => {
  it("is exactly the tables ensureBaselineSchema creates", () => {
    const path = temporarySqlitePath();
    const database = openSqliteDatabase(path);
    ensureBaselineSchema(database);
    database.close();

    expect([...BASELINE_TABLES].sort()).toEqual(
      tablesOf(path).filter((name) => name !== "sqlite_sequence"),
    );
  });

  it("ensureBaselineSchema that fails half way leaves no table behind", () => {
    const path = temporarySqlitePath();
    const database = openSqliteDatabase(path);
    // an earlier table of another shape: the baseline's index on it fails, after other tables were made
    database.exec("CREATE TABLE checkpoints (x TEXT)");

    expect(() => {
      ensureBaselineSchema(database);
    }).toThrow();

    expect(database.isTransaction).toBe(false);
    expect(
      database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map((row) => String(row.name)),
    ).toEqual(["checkpoints"]);
    database.close();
  });
});
