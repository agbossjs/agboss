/**
 * #500 — what `SqliteFencedEffectRepository` does beyond the published contract: a work that
 * is asynchronous and writes through the connection's `requireTransaction()` (#1317c: a rejection
 * rolls its rows back, its result and mark with them), the scope's mark refuses a lower token even when the lease's epoch
 * matches it, the sweep removes the marks too, and the store creates the leases' table it reads.
 */
import { effectKeyForTesting } from "../../../src/testing/contracts/effect-key.js";
import { describe, expect, it } from "vitest";
import { applicationContextOf } from "../../../src/flow/context/application-context.js";
import { NO_ENVIRONMENT_VALUES } from "../../../src/environments/resolve.js";
import { ExecutionFencedError } from "../../../src/app/lease-lost.js";
import { IdempotencyRunStatus } from "../../../src/infrastructure/fenced-effect.repository.js";
import { SqliteOutboundCallRepository } from "../../../src/infrastructure/sqlite/sqlite-outbound-call.repository.js";
import { SqliteExecutionLeaseRepository } from "../../../src/infrastructure/sqlite/sqlite-execution-lease.repository.js";
import { SqliteFencedEffectRepository } from "../../../src/infrastructure/sqlite/sqlite-fenced-effect.repository.js";
import { keyOf } from "../../../src/testing/contracts/fenced-effect-data.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { hours, seconds } from "../../../src/units/index.js";
import { connectionTo, temporarySqlitePath } from "../contracts/store-kinds.js";
import { storeClockOf } from "../../helpers/store-clock.js";

/** One instance's SQLite stores on a file of the test. */
function storesOn(path = temporarySqlitePath(), clock = new VirtualClock()) {
  const connection = connectionTo(path);
  const application = applicationContextOf({
    name: "fenced-application",
    version: "1.0.0",
    instanceId: "instance-1",
    startedAt: clock.now(),
    environmentName: "test",
    environment: NO_ENVIRONMENT_VALUES,
  });
  const effects = new SqliteFencedEffectRepository(connection, storeClockOf(clock));
  const leases = new SqliteExecutionLeaseRepository(connection, storeClockOf(clock), application);
  return { clock, connection, effects, leases };
}

async function held(leases: SqliteExecutionLeaseRepository, executionId = "execution-1") {
  const lease = await leases.acquire("default", executionId, hours(1));
  if (lease === undefined) throw new Error("the lease is held");
  return lease;
}

const count = (stores: ReturnType<typeof storesOn>, table: string): number =>
  Number(stores.connection.database.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n);

describe("#500: SqliteFencedEffectRepository", () => {
  it("an asynchronous work that rejects rolls back: no row, no mark, no result", async () => {
    const stores = storesOn();
    stores.connection.database.exec("CREATE TABLE rows (row TEXT)");
    const key = keyOf(await held(stores.leases));

    const call = stores.effects.runOnce(key, async () => {
      stores.connection.requireTransaction().prepare("INSERT INTO rows VALUES ('r1')").run();
      await Promise.resolve();
      return Promise.reject(new Error("a declined card"));
    });

    await expect(call).rejects.toThrow("a declined card");
    expect(count(stores, "rows")).toBe(0);
    expect(count(stores, "fenced_effect_marks")).toBe(0);
    expect(count(stores, "fenced_effect_results")).toBe(0);
  });

  it("an asynchronous work commits its rows with the result", async () => {
    const stores = storesOn();
    stores.connection.database.exec("CREATE TABLE rows (row TEXT)");
    const key = keyOf(await held(stores.leases));

    const ran = await stores.effects.runOnce(key, async () => {
      await Promise.resolve();
      stores.connection.requireTransaction().prepare("INSERT INTO rows VALUES ('r1')").run();
      return { receipt: "r1" };
    });

    expect(ran.status).toBe(IdempotencyRunStatus.Ran);
    expect(count(stores, "rows")).toBe(1);
    expect(count(stores, "fenced_effect_results")).toBe(1);
  });

  it("AC2: a token below the scope's mark is refused even when the lease's epoch is that token", async () => {
    const stores = storesOn();
    await held(stores.leases);
    // the lease store wiped (its epochs count from 1 again), the scope's mark kept at 2
    stores.connection.database.exec("DELETE FROM execution_leases");
    stores.connection.database
      .prepare("INSERT INTO fenced_effect_marks VALUES ('default:execution-1', 2, 0, NULL)")
      .run();
    const again = await held(stores.leases);

    const refused = stores.effects.runOnce(keyOf(again), () => ({ receipt: "r1" }));

    await expect(refused).rejects.toBeInstanceOf(ExecutionFencedError);
    await expect(refused).rejects.toMatchObject({ token: 1, observedToken: 2 });
  });

  it("the sweep's deletion removes a scope's mark whose expiry has come, and keeps a later one", async () => {
    const stores = storesOn();
    const at = (after: number) => new Date(stores.clock.now().getTime() + after);
    await stores.effects.runOnce(
      effectKeyForTesting(keyOf(await held(stores.leases)), { expiresAt: at(seconds(30)) }),
      () => "a",
    );
    await stores.effects.runOnce(
      effectKeyForTesting(keyOf(await held(stores.leases, "execution-2")), {
        expiresAt: at(seconds(300)),
      }),
      () => "b",
    );
    await stores.clock.advance(seconds(60));

    await stores.effects.deleteExpired(stores.clock.now());

    const marks = stores.connection.database
      .prepare("SELECT scope_key FROM fenced_effect_marks")
      .all();
    expect(marks.map((row) => row.scope_key)).toEqual(["default:execution-2"]);
  });

  it.each([
    [
      "the fenced effects' sweep",
      (stores: ReturnType<typeof storesOn>, before: Date) => stores.effects.deleteExpired(before),
    ],
    [
      "the outbound calls' sweep",
      (stores: ReturnType<typeof storesOn>, before: Date) =>
        new SqliteOutboundCallRepository(
          stores.connection,
          storeClockOf(stores.clock),
        ).deleteExpired(before),
    ],
  ])(
    "%s lifts no cancel mark (#1117): of a tree retired long before the cutoff, of one not over, of one cancelled before its first acquire",
    async (_, sweep) => {
      const stores = storesOn();
      const retired = await held(stores.leases, "execution-1");
      await held(stores.leases, "execution-3");
      await stores.leases.requestCancel({ tenantId: "default", rootExecutionId: "execution-1" });
      await stores.leases.requestCancel({ tenantId: "default", rootExecutionId: "execution-3" });
      await stores.leases.requestCancel({ tenantId: "default", rootExecutionId: "execution-4" });
      await stores.leases.retire(retired);
      await stores.clock.advance(seconds(60));

      await sweep(stores, new Date(stores.clock.now().getTime() + seconds(30)));

      const marks = stores.connection.database
        .prepare(
          `SELECT root_execution_id, lease_epoch, released FROM execution_leases
           WHERE cancel_requested_at IS NOT NULL ORDER BY root_execution_id`,
        )
        .all();
      expect(marks).toEqual([
        { root_execution_id: "execution-1", lease_epoch: 1, released: 3 },
        { root_execution_id: "execution-3", lease_epoch: 1, released: 0 },
        { root_execution_id: "execution-4", lease_epoch: 0, released: 1 },
      ]);
    },
  );

  it("creates the leases' table it reads: alone on a file it refuses, nothing to read yet", async () => {
    const connection = connectionTo(temporarySqlitePath());
    const effects = new SqliteFencedEffectRepository(connection, storeClockOf(new VirtualClock()));
    const key = effectKeyForTesting(
      keyOf({
        tenantId: "default",
        rootExecutionId: "e1",
        holderInstanceId: "i",
        token: 1,
        expiresAt: new Date(0),
        remaining: seconds(30),
      }),
    );

    await expect(effects.runOnce(key, () => null)).rejects.toMatchObject({
      observedToken: undefined,
    });
    await expect(effects.ping()).resolves.toBeUndefined();
  });

  it("a stored string, number or null comes back as it was", async () => {
    const stores = storesOn();
    const lease = await held(stores.leases);

    const ran = await stores.effects.runOnce(keyOf(lease, "text"), () => "receipt-1");
    const replayed = await stores.effects.runOnce(keyOf(lease, "text"), () => "other");
    const nothing = await stores.effects.runOnce(keyOf(lease, "none"), () => null);

    expect(ran).toEqual({ status: IdempotencyRunStatus.Ran, result: "receipt-1", token: 1 });
    expect(replayed.result).toBe("receipt-1");
    expect(nothing.result).toBeNull();
  });
});
