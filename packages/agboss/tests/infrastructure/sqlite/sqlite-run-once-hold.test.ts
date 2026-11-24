/**
 * #1317c — the SQLite mutex and the ambient transaction of `runOnce`: one synchronous connection is
 * shared by every repository of the file, so while an asynchronous `execute` keeps its `BEGIN
 * IMMEDIATE` open, every other operation waits behind it and never lands inside it (lease renewals,
 * served ahead, excepted); the hold is capped at 15 s; a nested transaction is refused; a statement
 * that failed poisons the transaction, which then rolls back instead of committing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { applicationContextOf } from "../../../src/flow/context/application-context.js";
import { NO_ENVIRONMENT_VALUES } from "../../../src/environments/resolve.js";
import { IdempotencyError } from "../../../src/core/error-families/effect-errors.js";
import { SqliteExecutionLeaseRepository } from "../../../src/infrastructure/sqlite/sqlite-execution-lease.repository.js";
import { SqliteExecutionTreeRepository } from "../../../src/infrastructure/sqlite/sqlite-execution-tree.repository.js";
import { SqliteFencedEffectRepository } from "../../../src/infrastructure/sqlite/sqlite-fenced-effect.repository.js";
import { SQLITE_HOLD_CAP } from "../../../src/infrastructure/sqlite/sqlite-connection.js";
import { keyOf } from "../../../src/testing/contracts/fenced-effect-data.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { hours, seconds } from "../../../src/units/index.js";
import { connectionTo, temporarySqlitePath } from "../contracts/store-kinds.js";
import { storeClockOf } from "../../helpers/store-clock.js";

function storesOn(path = temporarySqlitePath(), clock = new VirtualClock()) {
  const connection = connectionTo(path);
  const application = applicationContextOf({
    name: "hold-application",
    version: "1.0.0",
    instanceId: "instance-1",
    startedAt: clock.now(),
    environmentName: "test",
    environment: NO_ENVIRONMENT_VALUES,
  });
  const effects = new SqliteFencedEffectRepository(connection, storeClockOf(clock));
  const leases = new SqliteExecutionLeaseRepository(connection, storeClockOf(clock), application);
  const tree = new SqliteExecutionTreeRepository(connection);
  connection.database.exec("CREATE TABLE IF NOT EXISTS rows (row TEXT)");
  return { clock, connection, effects, leases, tree };
}

type Stores = ReturnType<typeof storesOn>;

async function leaseOf(stores: Stores, executionId = "execution-1") {
  const lease = await stores.leases.acquire("default", executionId, hours(1));
  if (lease === undefined) throw new Error("the lease is held");
  return lease;
}

function latch(): { readonly promise: Promise<void>; readonly open: () => void } {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** A few turns of the loop, real ones: what a waiting operation would have needed to run. */
const turns = async (): Promise<void> => {
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve));
};

const rowsOf = (stores: Stores): readonly string[] =>
  stores.connection.database
    .prepare("SELECT row FROM rows ORDER BY rowid")
    .all()
    .map((found) => String(found.row));

const TREE = { tenantId: "default", rootExecutionId: "execution-1" };

afterEach(() => {
  vi.useRealTimers();
});

describe("#1317c: the mutex of the SQLite file", () => {
  it("another repository's statement during an open runOnce never lands inside its transaction", async () => {
    const stores = storesOn();
    const key = keyOf(await leaseOf(stores));
    const hold = latch();
    const run = stores.effects.runOnce(key, async () => {
      stores.connection.requireTransaction().prepare("INSERT INTO rows VALUES ('effect')").run();
      await hold.promise;
      throw new Error("a declined card");
    });
    await turns();
    expect(stores.connection.database.isTransaction).toBe(true);

    let isWritten = false;
    const write = stores.tree.saveIfAbsentInTree(TREE, "k", "v").then((saved) => {
      isWritten = saved;
    });
    const read = stores.tree.findByIdInTree(TREE, "k");
    await turns();
    // queued: not run inside the open transaction, not run at all
    expect(isWritten).toBe(false);

    hold.open();
    await expect(run).rejects.toThrow("a declined card");
    await write;
    // the effect's row rolled back; the other repository's write was made after it, and stays
    expect(isWritten).toBe(true);
    expect(rowsOf(stores)).toEqual([]);
    expect(await read).toBe("v");
    expect(await stores.tree.findByIdInTree(TREE, "k")).toBe("v");
  });

  it("queued operations run in order once the transaction commits", async () => {
    const stores = storesOn();
    const key = keyOf(await leaseOf(stores));
    const hold = latch();
    const order: string[] = [];
    const run = stores.effects.runOnce(key, async () => {
      await hold.promise;
      stores.connection.requireTransaction().prepare("INSERT INTO rows VALUES ('effect')").run();
      return { done: true };
    });
    await turns();
    const first = stores.tree.saveIfAbsentInTree(TREE, "a", 1).then(() => order.push("first"));
    const second = stores.tree.saveIfAbsentInTree(TREE, "b", 2).then(() => order.push("second"));
    await turns();
    expect(order).toEqual([]);

    hold.open();
    await run;
    await Promise.all([first, second]);

    expect(order).toEqual(["first", "second"]);
    expect(rowsOf(stores)).toEqual(["effect"]);
  });

  it("the hold is capped at 15 s: rolled back, the queue goes on, a late statement writes nothing", async () => {
    vi.useFakeTimers();
    const stores = storesOn();
    const key = keyOf(await leaseOf(stores));
    const never = latch();
    let lateError: unknown;
    const run = stores.effects.runOnce(key, async () => {
      const transaction = stores.connection.requireTransaction();
      transaction.prepare("INSERT INTO rows VALUES ('effect')").run();
      await never.promise;
      try {
        transaction.prepare("INSERT INTO rows VALUES ('late')").run();
      } catch (error) {
        lateError = error;
      }
      return { done: true };
    });
    const settled = run.catch((error: unknown) => error);
    const queued = stores.tree.saveIfAbsentInTree(TREE, "k", "v");

    await vi.advanceTimersByTimeAsync(SQLITE_HOLD_CAP - 1);
    expect(stores.connection.database.isTransaction).toBe(true);
    await vi.advanceTimersByTimeAsync(2);

    expect(await settled).toBeInstanceOf(IdempotencyError.HoldTooLong);
    expect(await queued).toBe(true);
    expect(rowsOf(stores)).toEqual([]);
    never.open();
    await vi.advanceTimersByTimeAsync(1);
    expect(lateError).toBeInstanceOf(IdempotencyError.OutsideTransaction);
    expect(rowsOf(stores)).toEqual([]);
  });

  it("a lease renewal is served ahead of the queue while a long hold is open", async () => {
    const stores = storesOn();
    const lease = await leaseOf(stores);
    const key = keyOf(lease);
    const hold = latch();
    const run = stores.effects.runOnce(key, async () => {
      await hold.promise;
      return { done: true };
    });
    await turns();
    let isWritten = false;
    const queued = stores.tree.saveIfAbsentInTree(TREE, "k", "v").then(() => {
      isWritten = true;
    });
    await stores.clock.advance(seconds(10));

    const left = await stores.leases.renew(lease, seconds(30));

    // the renewal answered inside the open hold; the queued write still waits behind it
    expect(left).toBe(seconds(30));
    expect(isWritten).toBe(false);
    hold.open();
    await run;
    await queued;
    const expiresAt = Number(
      stores.connection.database
        .prepare("SELECT expires_at FROM execution_leases WHERE root_execution_id = 'execution-1'")
        .get()?.expires_at,
    );
    expect(expiresAt).toBe(stores.clock.now().getTime() + seconds(30));
  });

  it("two connections to one file in one process queue behind each other's holds", async () => {
    const path = temporarySqlitePath();
    const first = storesOn(path);
    const second = storesOn(path);
    const key = keyOf(await leaseOf(first));
    const hold = latch();
    const run = first.effects.runOnce(key, async () => {
      await hold.promise;
      return { done: true };
    });
    await turns();

    let isWritten = false;
    const write = second.tree.saveIfAbsentInTree(TREE, "k", "v").then(() => {
      isWritten = true;
    });
    await turns();
    expect(isWritten).toBe(false);

    hold.open();
    await run;
    await write;
    expect(isWritten).toBe(true);
  });
});

describe("#1317c: the ambient transaction", () => {
  it("requireTransaction() outside a runOnce is IdempotencyError.OutsideTransaction", () => {
    const stores = storesOn();

    expect(() => stores.connection.requireTransaction()).toThrow(
      IdempotencyError.OutsideTransaction,
    );
  });

  it("a nested connection.transaction() is refused with NestedTransaction; the effect goes on", async () => {
    const stores = storesOn();
    const key = keyOf(await leaseOf(stores));
    let refusal: unknown;

    const ran = await stores.effects.runOnce(key, async () => {
      await Promise.resolve();
      try {
        stores.connection.transaction(() => 1);
      } catch (error) {
        refusal = error;
      }
      return { done: true };
    });

    expect(refusal).toBeInstanceOf(IdempotencyError.NestedTransaction);
    expect(ran.result).toEqual({ done: true });
  });

  it("a second hold opened from inside a hold is refused, not left waiting for itself", async () => {
    const stores = storesOn();
    const key = keyOf(await leaseOf(stores));
    const other = keyOf(await leaseOf(stores, "execution-2"));
    let refusal: unknown;

    await stores.effects.runOnce(key, async () => {
      await Promise.resolve();
      await stores.effects
        .runOnce(other, () => 1)
        .catch((error: unknown) => {
          refusal = error;
        });
      return { done: true };
    });

    expect(refusal).toBeInstanceOf(IdempotencyError.NestedRunOnce);
  });

  it("a tainted handle refuses the next statement and the transaction rolls back, never commits", async () => {
    const stores = storesOn();
    const key = keyOf(await leaseOf(stores));
    let next: unknown;

    const call = stores.effects.runOnce(key, async () => {
      const transaction = stores.connection.requireTransaction();
      transaction.prepare("INSERT INTO rows VALUES ('before')").run();
      try {
        transaction.prepare("INSERT INTO no_such_table VALUES (1)").run();
      } catch {
        // caught: the effect goes on as if nothing happened
      }
      try {
        transaction.prepare("INSERT INTO rows VALUES ('after')").run();
      } catch (error) {
        next = error;
      }
      return { done: true };
    });

    await expect(call).rejects.toBeInstanceOf(IdempotencyError.TransactionPoisoned);
    expect(next).toBeInstanceOf(IdempotencyError.TransactionPoisoned);
    expect(rowsOf(stores)).toEqual([]);
    const results = stores.connection.database
      .prepare("SELECT count(*) AS n FROM fenced_effect_results")
      .get();
    expect(Number(results?.n)).toBe(0);
  });

  it("a handle kept past its runOnce refuses every statement", async () => {
    const stores = storesOn();
    const key = keyOf(await leaseOf(stores));
    let kept: ReturnType<typeof stores.connection.requireTransaction> | undefined;

    await stores.effects.runOnce(key, () => {
      kept = stores.connection.requireTransaction();
      return { done: true };
    });

    expect(() => kept?.prepare("INSERT INTO rows VALUES ('late')")).toThrow(
      IdempotencyError.OutsideTransaction,
    );
    expect(rowsOf(stores)).toEqual([]);
  });
});
