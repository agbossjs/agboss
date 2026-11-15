/**
 * #1117 (core): a SQLite file written before the mark moved onto the lease rows — its cancels in
 * `execution_cancel_requests` (#909) — is migrated at open: each mark onto its tree's lease row (a
 * tree with no row gets a seed row: token 0, released), the old table dropped, the file stamped
 * `SQLITE_SCHEMA_VERSION` (2). A second open, and a second store on the connection, change nothing;
 * a migrated mark fences as before, and the tree's first acquire after a seed is token 1.
 */
import { describe, expect, it } from "vitest";
import { ExecutionCancelFencedError } from "../../../src/app/lease-lost.js";
import { FencedEffectSettings } from "../../../src/infrastructure/fenced-effect-settings.js";
import {
  openSqliteDatabase,
  SQLITE_SCHEMA_VERSION,
} from "../../../src/infrastructure/sqlite/sqlite-connection.js";
import { SqliteExecutionLeaseRepository } from "../../../src/infrastructure/sqlite/sqlite-execution-lease.repository.js";
import { SqliteFencedEffectRepository } from "../../../src/infrastructure/sqlite/sqlite-fenced-effect.repository.js";
import { SqliteOutboundCallRepository } from "../../../src/infrastructure/sqlite/sqlite-outbound-call.repository.js";
import { stampOf } from "../../../src/infrastructure/sqlite/sqlite-schema-version.js";
import { keyOf } from "../../../src/testing/contracts/fenced-effect-data.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { hours } from "../../../src/units/index.js";
import { storeClockOf } from "../../helpers/store-clock.js";
import { applicationOn, connectionTo, temporarySqlitePath } from "../contracts/store-kinds.js";

/** A file as a build of #909 left it: stamped 1, the marks in their own table. */
function fileOfBefore(): string {
  const path = temporarySqlitePath();
  const database = openSqliteDatabase(path);
  database.exec(`
    CREATE TABLE agboss_schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
    INSERT INTO agboss_schema (id, version) VALUES (1, 1);
    CREATE TABLE execution_leases (
      tenant_id TEXT NOT NULL, root_execution_id TEXT NOT NULL, holder_instance_id TEXT NOT NULL,
      lease_epoch INTEGER NOT NULL, expires_at INTEGER NOT NULL, released INTEGER NOT NULL,
      yielded INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (tenant_id, root_execution_id));
    CREATE TABLE execution_cancel_requests (
      tenant_id TEXT NOT NULL, root_execution_id TEXT NOT NULL, requested_at INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, root_execution_id));
    INSERT INTO execution_leases VALUES ('default', 'held', 'instance-0', 4, 0, 1, 0);
    INSERT INTO execution_leases VALUES ('default', 'free', 'instance-0', 2, 0, 1, 0);
    INSERT INTO execution_cancel_requests VALUES ('default', 'held', 1000);
    INSERT INTO execution_cancel_requests VALUES ('default', 'early', 2000);
  `);
  database.close();
  return path;
}

/** The lease rows that carry a mark, in key order. */
function marksOn(path: string): readonly unknown[] {
  const database = openSqliteDatabase(path);
  try {
    return database
      .prepare(
        `SELECT root_execution_id, lease_epoch, released, cancel_requested_at FROM execution_leases
         WHERE cancel_requested_at IS NOT NULL ORDER BY root_execution_id`,
      )
      .all();
  } finally {
    database.close();
  }
}

function tablesOf(path: string): readonly string[] {
  const database = openSqliteDatabase(path);
  try {
    return database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => String(row.name));
  } finally {
    database.close();
  }
}

const clock = new VirtualClock();
const leasesOn = (path: string) =>
  new SqliteExecutionLeaseRepository(connectionTo(path), storeClockOf(clock), applicationOn(path));

describe("#1117: a SQLite file of before has its cancel marks moved onto the lease rows", () => {
  it("each mark lands on its tree's row, a tree with no row gets a seed row, the old table is gone and the file is stamped", () => {
    const path = fileOfBefore();

    leasesOn(path);

    expect(marksOn(path)).toEqual([
      { root_execution_id: "early", lease_epoch: 0, released: 1, cancel_requested_at: 2000 },
      { root_execution_id: "held", lease_epoch: 4, released: 1, cancel_requested_at: 1000 },
    ]);
    expect(tablesOf(path)).not.toContain("execution_cancel_requests");
    const database = openSqliteDatabase(path);
    expect(stampOf(database)).toBe(SQLITE_SCHEMA_VERSION);
    database.close();
    expect(SQLITE_SCHEMA_VERSION).toBe(2);
  });

  it("opened again, and by every fencing store of the file, it changes nothing", () => {
    const path = fileOfBefore();
    leasesOn(path);
    const once = marksOn(path);

    leasesOn(path);
    const connection = connectionTo(path);
    new SqliteFencedEffectRepository(connection, storeClockOf(clock), new FencedEffectSettings());
    new SqliteOutboundCallRepository(connection, storeClockOf(clock));

    expect(marksOn(path)).toEqual(once);
  });

  it("a fencing store opened first migrates the file too", () => {
    const path = fileOfBefore();

    new SqliteOutboundCallRepository(connectionTo(path), storeClockOf(clock));

    expect(marksOn(path)).toHaveLength(2);
    expect(tablesOf(path)).not.toContain("execution_cancel_requests");
  });

  it("a migrated mark fences: the next holder's write and the seeded tree's first lease (token 1) are refused", async () => {
    const path = fileOfBefore();
    const leases = leasesOn(path);
    const effects = new SqliteFencedEffectRepository(
      connectionTo(path),
      storeClockOf(clock),
      new FencedEffectSettings(),
    );
    const held = await leases.acquire("default", "held", hours(1));
    const early = await leases.acquire("default", "early", hours(1));
    const free = await leases.acquire("default", "free", hours(1));
    if (held === undefined || early === undefined || free === undefined)
      throw new Error("every free lease is taken");

    expect([held.token, early.token, early.takenOverFrom]).toEqual([5, 1, undefined]);
    await expect(effects.runOnce(keyOf(held), () => "a")).rejects.toBeInstanceOf(
      ExecutionCancelFencedError,
    );
    await expect(effects.runOnce(keyOf(early), () => "b")).rejects.toBeInstanceOf(
      ExecutionCancelFencedError,
    );
    expect((await effects.runOnce(keyOf(free), () => "c")).result).toBe("c");
  });
});
