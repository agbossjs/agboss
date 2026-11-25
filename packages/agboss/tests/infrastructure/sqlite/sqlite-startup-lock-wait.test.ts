/**
 * #1317: a repository's startup work (its migration, its DDL) is synchronous, so it cannot await
 * another process's write lock as an operation does. It waits inside SQLite for the busy window, as
 * the open does, and past it fails with a typed `StoreError.LockTimeout` — never at once with a raw
 * "database is locked" (a pod that started beside a writer died before it was ready).
 *
 * The lock is held by another process (the waiting thread is blocked while it waits, so the holder
 * is the one that lets go); no assertion is about elapsed time.
 */
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { StoreError, StoreErrorKind } from "../../../src/core/error-families/store-errors.js";
import { randomIdGenerator } from "../../../src/infrastructure/clock.js";
import { SqliteExecutionRecordRepository } from "../../../src/infrastructure/sqlite/sqlite-execution-record.repository.js";
import type { SqliteConnection } from "../../../src/infrastructure/sqlite/sqlite-connection.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { startNode, type NodeChild } from "../../helpers/process.js";
import { applicationOn, connectionTo, temporarySqlitePath } from "../contracts/store-kinds.js";

const HOLDER = fileURLToPath(new URL("./write-lock-holder-process.ts", import.meta.url));
const holders: { holder: NodeChild; releasedByTest: boolean }[] = [];

afterEach(async () => {
  for (const { holder, releasedByTest } of holders.splice(0)) {
    // a holder with a hold time lets go by itself
    if (releasedByTest) holder.send("release");
    await holder.exited;
  }
});

/** A process holding the write lock of `path`: for `holdMs`, or until the test releases it. */
async function holding(path: string, holdMs?: number): Promise<void> {
  const holder = startNode([
    "--import",
    "tsx",
    HOLDER,
    path,
    ...(holdMs === undefined ? [] : [String(holdMs)]),
  ]);
  await holder.waitFor((message) => message === "held");
  holders.push({ holder, releasedByTest: holdMs === undefined });
}

const recordsOn = (connection: SqliteConnection, path: string) =>
  new SqliteExecutionRecordRepository(
    connection,
    new VirtualClock(),
    applicationOn(path),
    randomIdGenerator,
  );

describe("#1317: startup work waits for another process's write lock", () => {
  it("a record store opened while another process writes is ready once the lock is released", async () => {
    const path = temporarySqlitePath();
    recordsOn(connectionTo(path), path);
    // the connection is open (the open waits for the lock on its own); the record store's startup is what meets it
    const connection = connectionTo(path);
    await holding(path, 400);

    expect(() => recordsOn(connection, path)).not.toThrow();
  }, 30_000);

  it("a lock held past the window fails with StoreError.LockTimeout, not a raw database-is-locked", async () => {
    const path = temporarySqlitePath();
    const connection = connectionTo(path);
    await holding(path);

    let failed: unknown;
    try {
      connection.startupWork(() => {
        connection.database.exec("BEGIN IMMEDIATE; COMMIT");
      }, 100);
    } catch (error) {
      failed = error;
    }

    expect(failed).toBeInstanceOf(StoreError.LockTimeout);
    expect((failed as StoreError).kind).toBe(StoreErrorKind.LockTimeout);
  }, 30_000);

  it("afterwards the connection waits no more inside SQLite (busy_timeout 0), whether the work passed or failed", () => {
    const connection = connectionTo(temporarySqlitePath());
    const timeout = () => connection.database.prepare("PRAGMA busy_timeout").get();

    connection.startupWork(() => undefined);
    expect(timeout()).toEqual({ timeout: 0 });
    expect(() =>
      connection.startupWork(() => {
        throw new Error("a failed migration");
      }),
    ).toThrow("a failed migration");
    expect(timeout()).toEqual({ timeout: 0 });
  });
});
