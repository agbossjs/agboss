/**
 * #1356 (pauses-sqlite shard) — the pause tables of a file an older version wrote, opened by this one on their
 * own: the paused runs keyed by tenant (#261, #265), the pause records out of the runs' rows (#267 S35), the
 * pauses unique per step key of a tree (#663) and their `seq` kept across opens (#935).
 */
import { describe, expect, it } from "vitest";
import { preparePauseTables } from "../../../src/infrastructure/sqlite/sqlite-pause-schema.js";
import { connectionTo, temporarySqlitePath } from "../contracts/store-kinds.js";

/** The tables of the file, by name. */
const tablesOf = (connection: ReturnType<typeof connectionTo>): string[] =>
  connection.database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => String(Object.values(row)[0]));

describe("#1356: paused runs written before tenants (#261, #265)", () => {
  it("are rebuilt keyed by tenant and thread, each row in the tenant `default`, the old table gone", () => {
    const path = temporarySqlitePath();
    const old = connectionTo(path);
    old.database.exec(`CREATE TABLE paused_executions (
      thread_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, run TEXT NOT NULL,
      workflow_version TEXT NOT NULL, config_hash TEXT NOT NULL, paused_at TEXT NOT NULL,
      status TEXT, decision TEXT);
      INSERT INTO paused_executions VALUES ('thread-1', 'run-1', '{}', '1.0.0', 'hash', 'at', 'pending', NULL);`);

    const connection = connectionTo(path);
    preparePauseTables(connection);

    expect(connection.columnsOf("paused_executions")).toEqual([
      "tenant_id",
      "thread_id",
      "run_id",
      "run",
      "workflow_version",
      "config_hash",
      "paused_at",
    ]);
    expect(
      connection.database
        .prepare("SELECT tenant_id, thread_id, run_id FROM paused_executions")
        .all(),
    ).toEqual([{ tenant_id: "default", thread_id: "thread-1", run_id: "run-1" }]);
    expect(tablesOf(connection)).not.toContain("paused_executions_before_tenants");
  });
});

describe("#1356: paused runs that kept their pause's status and decision (#267 S35)", () => {
  it("lose those columns: a pause is a record of its own now", () => {
    const path = temporarySqlitePath();
    const old = connectionTo(path);
    old.database.exec(`CREATE TABLE paused_executions (
      tenant_id TEXT NOT NULL, thread_id TEXT NOT NULL, run_id TEXT NOT NULL, run TEXT NOT NULL,
      workflow_version TEXT NOT NULL, config_hash TEXT NOT NULL, paused_at TEXT NOT NULL,
      status TEXT, decision TEXT, PRIMARY KEY (tenant_id, thread_id));
      INSERT INTO paused_executions VALUES ('acme', 'thread-1', 'run-1', '{}', '1.0.0', 'hash', 'at', 'pending', NULL);`);

    const connection = connectionTo(path);
    preparePauseTables(connection);

    expect(connection.columnsOf("paused_executions")).toEqual([
      "tenant_id",
      "thread_id",
      "run_id",
      "run",
      "workflow_version",
      "config_hash",
      "paused_at",
    ]);
    expect(
      connection.database.prepare("SELECT tenant_id, thread_id FROM paused_executions").all(),
    ).toEqual([{ tenant_id: "acme", thread_id: "thread-1" }]);
  });

  it("a file that has neither is left as it is, and a new one is made whole", () => {
    const connection = connectionTo(temporarySqlitePath());

    preparePauseTables(connection);
    const columns = connection.columnsOf("paused_executions");
    preparePauseTables(connection);

    expect(columns).toEqual([
      "tenant_id",
      "thread_id",
      "run_id",
      "run",
      "workflow_version",
      "config_hash",
      "paused_at",
    ]);
    expect(connection.columnsOf("paused_executions")).toEqual(columns);
    expect(tablesOf(connection)).toEqual(
      expect.arrayContaining(["paused_executions", "pauses", "pause_notices"]),
    );
  });
});

describe("#1356: pauses unique per step key of a tenant, not of a tree (#663)", () => {
  it("are rebuilt unique per step key of a tree, their rows kept in their order, the old table gone, the indexes made again", () => {
    const path = temporarySqlitePath();
    const old = connectionTo(path);
    // a file with every later column but `seq` made unique per tenant: only the rebuild for trees applies
    old.database.exec(`CREATE TABLE pauses (
      tenant_id TEXT NOT NULL, pause_id TEXT NOT NULL, step_key TEXT NOT NULL,
      root_execution_id TEXT NOT NULL, status TEXT NOT NULL, is_sent INTEGER NOT NULL,
      pause TEXT NOT NULL, answer TEXT, resolution TEXT, resolved_at TEXT,
      expires_at TEXT, remind_at TEXT, channel TEXT, seq INTEGER PRIMARY KEY AUTOINCREMENT,
      UNIQUE (tenant_id, pause_id), UNIQUE (tenant_id, step_key));
      CREATE INDEX pauses_by_root ON pauses (tenant_id, root_execution_id);`);
    for (const id of ["p-3", "p-1", "p-2"])
      old.database
        .prepare(
          "INSERT INTO pauses (tenant_id, pause_id, step_key, root_execution_id, status, is_sent, pause) VALUES ('default', ?, ?, 'run-1', 'pending', 1, '{}')",
        )
        .run(id, `run-1:s:1:${id}`);

    const connection = connectionTo(path);
    preparePauseTables(connection);

    const unique = connection.uniqueIndexesOf("pauses");
    expect(unique).toContain("tenant_id,root_execution_id,step_key");
    expect(unique).not.toContain("tenant_id,step_key");
    expect(connection.database.prepare("SELECT pause_id FROM pauses ORDER BY seq").all()).toEqual([
      { pause_id: "p-3" },
      { pause_id: "p-1" },
      { pause_id: "p-2" },
    ]);
    expect(tablesOf(connection)).not.toContain("pauses_before_trees");
    // the same step key in another tree is a pause of its own now
    expect(() => {
      connection.database
        .prepare(
          "INSERT INTO pauses (tenant_id, pause_id, step_key, root_execution_id, status, is_sent, pause) VALUES ('default', 'p-4', 'run-1:s:1:p-3', 'run-2', 'pending', 1, '{}')",
        )
        .run();
    }).not.toThrow();
    expect(
      connection.database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'pauses'")
        .all()
        .map((row) => String(row.name)),
    ).toEqual(expect.arrayContaining(["pauses_by_root", "pauses_by_tenant"]));
  });
});

describe("#1356: the columns a pause file gains", () => {
  it("a file with `seq` is not rebuilt at every open: a number given is never given again", () => {
    const path = temporarySqlitePath();
    const first = connectionTo(path);
    preparePauseTables(first);
    const insert = (connection: typeof first, id: string): void => {
      connection.database
        .prepare(
          "INSERT INTO pauses (tenant_id, pause_id, step_key, root_execution_id, status, is_sent, pause, channel) VALUES ('default', ?, ?, 'run-1', 'pending', 1, '{}', 'c')",
        )
        .run(id, `run-1:s:1:${id}`);
    };
    for (const id of ["p-1", "p-2", "p-3"]) insert(first, id);
    first.database.prepare("DELETE FROM pauses WHERE pause_id = 'p-3'").run();

    const reopened = connectionTo(path);
    preparePauseTables(reopened);
    insert(reopened, "p-4");

    expect(
      reopened.database.prepare("SELECT seq FROM pauses WHERE pause_id = 'p-4'").get(),
    ).toEqual({ seq: 4 });
  });
});
