/**
 * #500 — what `SqliteFencedEffectRepository` does beyond the published contract: a work that
 * returns a promise is rolled back with `FencedEffectAsyncWorkError` (nothing written, its
 * rejection not left unhandled), the scope's mark refuses a lower token even when the lease's epoch
 * matches it, the sweep removes the marks too, and the store creates the leases' table it reads.
 */
import { describe, expect, it } from "vitest";
import { applicationContextOf } from "../../../src/flow/context/application-context.js";
import { NO_ENVIRONMENT_VALUES } from "../../../src/environments/resolve.js";
import { ExecutionFencedError } from "../../../src/app/lease-lost.js";
import { FencedEffectStatus } from "../../../src/infrastructure/fenced-effect.repository.js";
import { FencedEffectSettings } from "../../../src/infrastructure/fenced-effect-settings.js";
import { SqliteExecutionLeaseRepository } from "../../../src/infrastructure/sqlite/sqlite-execution-lease.repository.js";
import {
  FencedEffectAsyncWorkError,
  SqliteFencedEffectRepository,
} from "../../../src/infrastructure/sqlite/sqlite-fenced-effect.repository.js";
import { keyOf } from "../../../src/testing/contracts/fenced-effect-data.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { hours, seconds } from "../../../src/units/index.js";
import { connectionTo, temporarySqlitePath } from "../contracts/store-kinds.js";

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
  const effects = new SqliteFencedEffectRepository(connection, clock, new FencedEffectSettings());
  const leases = new SqliteExecutionLeaseRepository(connection, clock, application);
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
  it("a work that returns a promise rolls back: FencedEffectAsyncWorkError, no row, no mark", async () => {
    const stores = storesOn();
    stores.connection.database.exec("CREATE TABLE rows (row TEXT)");
    const key = keyOf(await held(stores.leases));

    const call = stores.effects.saveResultIfAbsent(key, async (database) => {
      database.prepare("INSERT INTO rows VALUES ('r1')").run();
      return Promise.reject(new Error("an API call inside the transaction"));
    });

    await expect(call).rejects.toBeInstanceOf(FencedEffectAsyncWorkError);
    await expect(call).rejects.toMatchObject({
      code: "fenced-effect.async-work",
      effect: "charge",
    });
    await expect(call).rejects.toThrow(/do the I\/O before or after the call/);
    expect(count(stores, "rows")).toBe(0);
    expect(count(stores, "fenced_effect_marks")).toBe(0);
    expect(count(stores, "fenced_effect_results")).toBe(0);
  });

  it("AC2: a token below the scope's mark is refused even when the lease's epoch is that token", async () => {
    const stores = storesOn();
    await held(stores.leases);
    // the lease store wiped (its epochs count from 1 again), the scope's mark kept at 2
    stores.connection.database.exec("DELETE FROM execution_leases");
    stores.connection.database
      .prepare("INSERT INTO fenced_effect_marks VALUES ('default:execution-1', 2, 0)")
      .run();
    const again = await held(stores.leases);

    const refused = stores.effects.saveResultIfAbsent(keyOf(again), () => ({ receipt: "r1" }));

    await expect(refused).rejects.toBeInstanceOf(ExecutionFencedError);
    await expect(refused).rejects.toMatchObject({ token: 1, observedToken: 2 });
  });

  it("the sweep's deletion removes a scope's mark stored before the cutoff, and keeps a later one", async () => {
    const stores = storesOn();
    await stores.effects.saveResultIfAbsent(keyOf(await held(stores.leases)), () => "a");
    await stores.clock.advance(seconds(60));
    await stores.effects.saveResultIfAbsent(
      keyOf(await held(stores.leases, "execution-2")),
      () => "b",
    );

    await stores.effects.deleteByStoredAtBefore(
      new Date(stores.clock.now().getTime() - seconds(30)),
    );

    const marks = stores.connection.database
      .prepare("SELECT scope_key FROM fenced_effect_marks")
      .all();
    expect(marks.map((row) => row.scope_key)).toEqual(["default:execution-2"]);
  });

  it("creates the leases' table it reads: alone on a file it refuses, nothing to read yet", async () => {
    const connection = connectionTo(temporarySqlitePath());
    const effects = new SqliteFencedEffectRepository(
      connection,
      new VirtualClock(),
      new FencedEffectSettings(),
    );
    const key = {
      ...keyOf({
        tenantId: "default",
        rootExecutionId: "e1",
        holderInstanceId: "i",
        leaseEpoch: 1,
        expiresAt: new Date(0),
      }),
    };

    await expect(effects.saveResultIfAbsent(key, () => null)).rejects.toMatchObject({
      observedToken: undefined,
    });
    await expect(effects.ping()).resolves.toBeUndefined();
  });

  it("a stored string, number or null comes back as it was", async () => {
    const stores = storesOn();
    const lease = await held(stores.leases);

    const ran = await stores.effects.saveResultIfAbsent(keyOf(lease, "text"), () => "receipt-1");
    const replayed = await stores.effects.saveResultIfAbsent(keyOf(lease, "text"), () => "other");
    const nothing = await stores.effects.saveResultIfAbsent(keyOf(lease, "none"), () => null);

    expect(ran).toEqual({ status: FencedEffectStatus.Ran, result: "receipt-1", token: 1 });
    expect(replayed.result).toBe("receipt-1");
    expect(nothing.result).toBeNull();
  });
});
