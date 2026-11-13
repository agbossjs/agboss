/**
 * #935 AC5: a file written before the pause store contract v2 (`bd617020`'s `pauses` table: no
 * deadline, reminder or channel column, no notice table) opens, keeps its pauses and gains them.
 */
import { describe, expect, it } from "vitest";
import { PauseStatus } from "../../../src/index.js";
import { SqlitePausedExecutionRepository } from "../../../src/infrastructure/sqlite/sqlite-paused-execution.repository.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { connectionTo, temporarySqlitePath } from "../contracts/store-kinds.js";
import { oldPauseJson } from "./pause-names-0.1.0.fixtures.js";

/** The table as `bd617020` made it, with its two indexes. */
const BEFORE_V2 = `CREATE TABLE pauses (
  tenant_id TEXT NOT NULL, pause_id TEXT NOT NULL, step_key TEXT NOT NULL,
  root_execution_id TEXT NOT NULL, status TEXT NOT NULL, is_sent INTEGER NOT NULL,
  pause TEXT NOT NULL, answer TEXT, resolution TEXT, resolved_at TEXT,
  PRIMARY KEY (tenant_id, pause_id), UNIQUE (tenant_id, root_execution_id, step_key));
CREATE INDEX pauses_by_root ON pauses (tenant_id, root_execution_id);
CREATE INDEX pauses_by_resolved_at ON pauses (status, resolved_at);`;

describe("AC5: a 0.1.1-pre file opens, keeps its pauses, gains the columns", () => {
  it("a 0.1.1-pre file opens, keeps its pauses, gains the columns", async () => {
    const path = temporarySqlitePath();
    const old = connectionTo(path);
    old.database.exec(BEFORE_V2);
    for (const id of ["p1", "p2"])
      old.database
        .prepare(
          "INSERT INTO pauses (tenant_id, pause_id, step_key, root_execution_id, status, is_sent, pause) VALUES ('default', ?, ?, 'run-1', 'pending', 1, ?)",
        )
        .run(id, `run-1:s:1:${id}`, oldPauseJson);

    const connection = connectionTo(path);
    const pauses = new SqlitePausedExecutionRepository(connection, new VirtualClock(new Date(0)));

    const page = await pauses.findPageByTenantId(
      "default",
      { statuses: [PauseStatus.Pending], channel: "refund-approval-channel" },
      10,
    );
    expect(page.pauses.map((pause) => pause.pauseId)).toEqual(["p1", "p2"]);
    expect(page.pauses[0]).toMatchObject({ channel: "refund-approval-channel", isSent: true });
    expect(page.pauses[0]?.expiresAt).toBeUndefined();
    expect(connection.columnsOf("pauses")).toEqual(
      expect.arrayContaining(["expires_at", "remind_at", "channel"]),
    );
    expect(connection.columnsOf("pause_notices")).toContain("head_written_at");
    // a second open changes nothing, and the pause takes a deadline-aware close
    const again = new SqlitePausedExecutionRepository(
      connectionTo(path),
      new VirtualClock(new Date(0)),
    );
    expect(await again.findOpenAfter(undefined, 10)).toMatchObject({
      pauses: [{ pauseId: "p1" }, { pauseId: "p2" }],
    });
    expect(await again.findPendingByExpiresAtBefore(new Date("2099-01-01"), 10)).toEqual([]);
  });

  it("#935: a v2 file without `seq` is rebuilt with it, its order kept, and no number is given twice", async () => {
    const path = temporarySqlitePath();
    const old = connectionTo(path);
    old.database.exec(`CREATE TABLE pauses (
      tenant_id TEXT NOT NULL, pause_id TEXT NOT NULL, step_key TEXT NOT NULL,
      root_execution_id TEXT NOT NULL, status TEXT NOT NULL, is_sent INTEGER NOT NULL,
      pause TEXT NOT NULL, answer TEXT, resolution TEXT, resolved_at TEXT,
      expires_at TEXT, remind_at TEXT, channel TEXT,
      PRIMARY KEY (tenant_id, pause_id), UNIQUE (tenant_id, root_execution_id, step_key));
    CREATE INDEX pauses_by_tenant ON pauses (tenant_id, status, channel);`);
    for (const id of ["p3", "p1", "p2"])
      old.database
        .prepare(
          "INSERT INTO pauses (tenant_id, pause_id, step_key, root_execution_id, status, is_sent, pause, channel) VALUES ('default', ?, ?, 'run-1', 'pending', 1, ?, 'refund-approval-channel')",
        )
        .run(id, `run-1:s:1:${id}`, oldPauseJson);

    const connection = connectionTo(path);
    const pauses = new SqlitePausedExecutionRepository(connection, new VirtualClock(new Date(0)));

    const first = await pauses.findOpenAfter(undefined, 2);
    expect(connection.columnsOf("pauses")).toContain("seq");
    expect(first.pauses.map((pause) => pause.pauseId)).toEqual(["p3", "p1"]);
    // the cursor row and every later one removed, a new one inserted: after the cursor, never behind it
    connection.database.exec("DELETE FROM pauses WHERE pause_id IN ('p1', 'p2')");
    const [base] = first.pauses;
    expect(base).toBeDefined();
    if (base === undefined) return;
    await pauses.findOrCreateByStepKey({ ...base, pauseId: "p4", stepKey: "k4" });
    const next = await pauses.findOpenAfter(first.next, 10);
    expect(next.pauses.map((pause) => pause.pauseId)).toEqual(["p4"]);
  });

  it("#935: a file whose rowids have gaps (1, 3, 4, 5) keeps them as `seq`: a cursor issued before the upgrade skips no row", async () => {
    const path = temporarySqlitePath();
    const old = connectionTo(path);
    old.database.exec(`CREATE TABLE pauses (
      tenant_id TEXT NOT NULL, pause_id TEXT NOT NULL, step_key TEXT NOT NULL,
      root_execution_id TEXT NOT NULL, status TEXT NOT NULL, is_sent INTEGER NOT NULL,
      pause TEXT NOT NULL, answer TEXT, resolution TEXT, resolved_at TEXT,
      expires_at TEXT, remind_at TEXT, channel TEXT,
      PRIMARY KEY (tenant_id, pause_id), UNIQUE (tenant_id, root_execution_id, step_key));`);
    const ids = new Map([
      [1, "p1"],
      [3, "p3"],
      [4, "p4"],
      [5, "p5"],
    ]);
    for (const [rowid, id] of ids)
      old.database
        .prepare(
          "INSERT INTO pauses (rowid, tenant_id, pause_id, step_key, root_execution_id, status, is_sent, pause, channel) VALUES (?, 'default', ?, ?, 'run-1', 'pending', 1, ?, 'refund-approval-channel')",
        )
        .run(rowid, id, `run-1:s:1:${id}`, oldPauseJson);

    const connection = connectionTo(path);
    const pauses = new SqlitePausedExecutionRepository(connection, new VirtualClock(new Date(0)));

    // the cursor the file's own store handed out after p3, before the upgrade: its rowid
    const beforeUpgrade = "3";
    const after = await pauses.findOpenAfter(beforeUpgrade, 10);
    expect(after.pauses.map((pause) => pause.pauseId)).toEqual(["p4", "p5"]);
    const first = await pauses.findOpenAfter(undefined, 2);
    expect(first.pauses.map((pause) => pause.pauseId)).toEqual(["p1", "p3"]);
    expect(first.next).toBe(beforeUpgrade);
    const tenant = await pauses.findPageByTenantId(
      "default",
      { statuses: [PauseStatus.Pending] },
      10,
      beforeUpgrade,
    );
    expect(tenant.pauses.map((pause) => pause.pauseId)).toEqual(["p4", "p5"]);
  });
});
