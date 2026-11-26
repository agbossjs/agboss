import { ExecutionError } from "../../src/core/error-families/run-errors.js";
/**
 * #533 item 3 — the in-memory fenced-effect store and the contract's base class at their edges: the
 * transactions of one scope wait for each other even when a write is asynchronous, and each scope's
 * lock is gone once its last transaction settled; a result and a mark expiring at the sweep's now
 * are removed; the scope's mark is the highest token that wrote or replayed it; a step's replay names
 * no origin; the entry checks run in their order (name, business key, the key's shape) and a key's
 * join is its own; a result of exactly `maxResultSize` bytes is stored.
 */
import { IdempotencyError } from "../../src/core/error-families/effect-errors.js";
import { effectKeyForTesting } from "../../src/testing/contracts/effect-key.js";
import { storeMismatch } from "../../src/infrastructure/idempotency-errors.js";
import { describe, expect, it } from "vitest";
import { applicationContextOf } from "../../src/flow/context/application-context.js";
import {
  ExecutionLeaseRepository,
  InMemoryExecutionLeaseRepository,
} from "../../src/infrastructure/execution-lease.repository.js";
import { IdempotencyRunStatus } from "../../src/infrastructure/fenced-effect.repository.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { InMemoryFencedEffectRepository } from "../../src/infrastructure/in-memory-fenced-effect.repository.js";
import { keyOf } from "../../src/testing/contracts/fenced-effect-data.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { hours, seconds, type Bytes } from "../../src/units/index.js";
import { storeClockOf } from "../helpers/store-clock.js";

/** One instance's stores over a new database. */
function storesOn() {
  const clock = new VirtualClock();
  const database = new InMemoryDatabase();
  const application = applicationContextOf({
    ...{ name: "fenced-application", version: "1.0.0", instanceId: "instance-1" },
    ...{ startedAt: clock.now(), profiles: ["test"] },
  });
  const leases = new InMemoryExecutionLeaseRepository(storeClockOf(clock), application, database);
  const effects = new InMemoryFencedEffectRepository(storeClockOf(clock), database, leases);
  return { clock, database, leases, effects };
}

async function held(leases: ExecutionLeaseRepository, executionId = "execution-1") {
  const lease = await leases.acquire("default", executionId, hours(1));
  if (lease === undefined) throw new Error("the lease is held");
  return lease;
}

/** A gate the test opens. */
function closedGate(): { readonly passed: Promise<void>; readonly open: () => void } {
  let open = (): void => undefined;
  const passed = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    passed,
    open: () => {
      open();
    },
  };
}

const settled = async (): Promise<void> => {
  for (let tick = 0; tick < 20; tick += 1) await new Promise((resolve) => setImmediate(resolve));
};

/** A write that says it started, then waits at `gate`. */
const startedAt =
  (started: string[], name: string, gate?: Promise<void>) => async (): Promise<object> => {
    started.push(name);
    await gate;
    return { receipt: name };
  };

describe("#533: one scope's transactions, in turn", () => {
  it("a second key of the scope waits for an asynchronous write of the first", async () => {
    const { leases, effects } = storesOn();
    const lease = await held(leases);
    const [gate, started] = [closedGate(), [] as string[]];

    const calls = [
      effects.runOnce(keyOf(lease, "charge"), startedAt(started, "charge", gate.passed)),
      effects.runOnce(keyOf(lease, "notify"), startedAt(started, "notify")),
    ];
    await settled();
    const startedWhileWaiting = [...started];
    gate.open();
    await Promise.all(calls);

    expect(startedWhileWaiting).toEqual(["charge"]);
    expect(started).toEqual(["charge", "notify"]);
  });

  it("a third key waits for the second, though the first ended meanwhile", async () => {
    const { leases, effects } = storesOn();
    const lease = await held(leases);
    const [first, second, started] = [closedGate(), closedGate(), [] as string[]];
    const one = effects.runOnce(keyOf(lease, "a"), startedAt(started, "a", first.passed));
    const two = effects.runOnce(keyOf(lease, "b"), startedAt(started, "b", second.passed));
    first.open();
    await one;
    await settled();

    const three = effects.runOnce(keyOf(lease, "c"), startedAt(started, "c"));
    await settled();
    const startedBeforeTheSecondEnded = [...started];
    second.open();
    await Promise.all([two, three]);

    expect(startedBeforeTheSecondEnded).toEqual(["a", "b"]);
    expect(started).toEqual(["a", "b", "c"]);
  });

  it("the scope's lock is gone once its last transaction settled", async () => {
    const { database, leases, effects } = storesOn();
    const lease = await held(leases);

    await effects.runOnce(keyOf(lease), () => ({ receipt: "r" }));
    await settled();

    expect(database.fencedEffectLocks.size).toBe(0);
  });

  it("ping() resolves", async () => {
    await expect(storesOn().effects.ping()).resolves.toBeUndefined();
  });
});

describe("#533: the scope's mark and the sweep", () => {
  it("the mark is the token that wrote the scope", async () => {
    const { database, leases, effects } = storesOn();
    const lease = await held(leases);

    await effects.runOnce(keyOf(lease), () => ({ receipt: "r" }));

    expect(database.fencedEffectMarks.get(keyOf(lease).scopeKey)?.highestToken).toBe(1);
  });

  it("a replay under a newer token raises the mark to it", async () => {
    const { database, leases, effects } = storesOn();
    const first = await held(leases);
    await effects.runOnce(keyOf(first), () => ({ receipt: "r" }));
    await leases.release(first);
    const second = await held(leases);

    const replay = await effects.runOnce(keyOf(second), () => ({ receipt: "again" }));

    expect(replay.status).toBe(IdempotencyRunStatus.Replayed);
    expect(database.fencedEffectMarks.get(keyOf(second).scopeKey)?.highestToken).toBe(2);
  });

  it("a result and a mark expiring exactly now are removed, and counted; one with no expiry is kept", async () => {
    const { clock, database, leases, effects } = storesOn();
    const lease = await held(leases);
    await effects.runOnce(keyOf(lease), () => ({ receipt: "r" }));
    await expect(effects.deleteExpired(clock.now())).resolves.toBe(0);
    expect([database.fencedEffectResults.size, database.fencedEffectMarks.size]).toEqual([1, 1]);

    await effects.runOnce(
      effectKeyForTesting(keyOf(lease, "ends"), { expiresAt: clock.now() }),
      () => ({ receipt: "r" }),
    );
    await expect(effects.deleteExpired(clock.now())).resolves.toBe(1);
    // the scope's mark holds the latest expiry written under it: Forever
    expect([database.fencedEffectResults.size, database.fencedEffectMarks.size]).toEqual([1, 1]);
  });

  it("a step's replay names no origin: the outcome has no replayedFrom at all", async () => {
    const { leases, effects } = storesOn();
    const key = keyOf(await held(leases));
    await effects.runOnce(key, () => ({ receipt: "r" }));

    const replay = await effects.runOnce(key, () => ({ receipt: "again" }));

    expect(replay).toStrictEqual({
      status: IdempotencyRunStatus.Replayed,
      result: { receipt: "r" },
      token: 1,
    });
  });
});

describe("#533: the base class's entry checks", () => {
  it("the name first: a bad name and a bad business key is IdempotencyError.InvalidName", async () => {
    const { leases, effects } = storesOn();
    const key = effectKeyForTesting(keyOf(await held(leases)), {
      name: "no spaces",
      businessKey: "a\u0001b",
    });

    await expect(effects.runOnce(key, () => ({}))).rejects.toBeInstanceOf(
      IdempotencyError.InvalidName,
    );
  });

  it("then the business key: a bad one with a bad scope is IdempotencyError.InvalidKey", async () => {
    const { leases, effects } = storesOn();
    const key = effectKeyForTesting(keyOf(await held(leases)), {
      scopeKey: "other:scope",
      businessKey: "a\u0001b",
    });

    await expect(effects.runOnce(key, () => ({}))).rejects.toBeInstanceOf(
      IdempotencyError.InvalidKey,
    );
  });

  it("a key whose scope does not match its parts is an IdempotencyError.InvalidKey", async () => {
    const { leases, effects } = storesOn();
    const key = effectKeyForTesting(keyOf(await held(leases)), { scopeKey: "other:scope" });

    await expect(effects.runOnce(key, () => ({}))).rejects.toMatchObject({
      name: "IdempotencyError.InvalidKey",
      message: expect.stringContaining("not a fenced effect key") as unknown,
    });
  });

  it("two keys whose parts run together are not one join: each runs its own transaction", async () => {
    const { leases, effects } = storesOn();
    const first = await held(leases);
    await leases.release(first);
    const lease = await held(leases);
    // "charge" at token 12 and "charge1" at token 2 read alike without a separator between the parts
    const stale = effectKeyForTesting(keyOf(lease, "charge"), { token: 12 });

    const [refused, ran] = await Promise.allSettled([
      effects.runOnce(stale, () => ({ receipt: "stale" })),
      effects.runOnce(keyOf(lease, "charge1"), () => ({ receipt: "ran" })),
    ]);

    expect(refused).toMatchObject({
      status: "rejected",
      reason: expect.any(ExecutionError.Fenced),
    });
    expect(ran).toMatchObject({ status: "fulfilled", value: { status: IdempotencyRunStatus.Ran } });
  });

  it("a result of exactly maxResultSize bytes is stored", async () => {
    const result = { receipt: "r" };
    const size = Buffer.byteLength(JSON.stringify(result), "utf8") as Bytes;
    const { leases, effects } = storesOn();

    const outcome = await effects.runOnce(
      effectKeyForTesting(keyOf(await held(leases)), { maxResultSize: size }),
      () => result,
    );

    expect(outcome.status).toBe(IdempotencyRunStatus.Ran);
  });
});

describe("#909, #1117: a tree's cancel mark in memory", () => {
  const tree = { tenantId: "default", rootExecutionId: "execution-1" };
  const ROW = "default\u0000execution-1";

  it("is stamped on the tree's lease row at the first request and kept when asked again", async () => {
    const { clock, database, leases } = storesOn();
    await held(leases);
    await leases.requestCancel(tree);
    const stamped = clock.now().getTime();
    await clock.advance(seconds(60));
    await leases.requestCancel(tree);

    expect(database.executionLeases.get(ROW)?.cancelRequestedAt).toBe(stamped);
  });

  it("no sweep lifts it, the tree retired or not, at any cutoff: its write is still refused", async () => {
    const { clock, database, leases, effects } = storesOn();
    const lease = await held(leases);
    const key = keyOf(lease);
    await leases.requestCancel(tree);
    await clock.advance(seconds(60));
    await effects.deleteExpired(new Date(clock.now().getTime() + seconds(60)));
    await expect(effects.runOnce(key, () => ({}))).rejects.toBeInstanceOf(
      ExecutionError.CancelFenced,
    );
    await leases.retire(lease);

    await effects.deleteExpired(new Date(clock.now().getTime() + seconds(60)));

    expect(database.executionLeases.get(ROW)).toMatchObject({ isRetired: true });
    expect(database.executionLeases.get(ROW)?.cancelRequestedAt).toBeDefined();
  });

  it("a cancel before the first acquire is a seed row — token 0, released, never held — that the acquire keeps the mark of", async () => {
    const { database, leases } = storesOn();
    await leases.requestCancel(tree);

    expect(database.executionLeases.get(ROW)).toMatchObject({
      released: true,
      lease: { token: 0, holderInstanceId: "" },
    });
    const lease = await held(leases);
    expect(lease).toMatchObject({ token: 1 });
    expect(database.executionLeases.get(ROW)?.cancelRequestedAt).toBeDefined();
  });

  it("every write of the row keeps the mark: renew, yield, reclaim, release, a takeover", async () => {
    const { clock, database, leases } = storesOn();
    const lease = await held(leases);
    await leases.requestCancel(tree);
    const mark = database.executionLeases.get(ROW)?.cancelRequestedAt;
    await leases.renew(lease, seconds(30));
    await leases.yield(lease);
    const reclaimed = await leases.reclaim(lease, seconds(30));
    if (reclaimed === undefined) throw new Error("the holder reclaims its yielded lease");
    await leases.release(reclaimed);
    await held(leases);
    await clock.advance(hours(2));
    await held(leases);

    expect(database.executionLeases.get(ROW)?.cancelRequestedAt).toBe(mark);
  });
});

describe("#533: a store beside another lease store", () => {
  it("IdempotencyError.StoreMismatch names both stores and the fix", () => {
    const error = storeMismatch({
      fencedEffectRepository: "InMemoryFencedEffectRepository",
      leaseRepository: "SqliteExecutionLeaseRepository",
      expectedLeaseRepository: "InMemoryExecutionLeaseRepository",
    });

    expect(error.name).toBe("IdempotencyError.StoreMismatch");
    expect(error.message).toBe(
      "InMemoryFencedEffectRepository checks the leases of InMemoryExecutionLeaseRepository, but the application's leases are in SqliteExecutionLeaseRepository: list the idempotency store of that lease store's database in @Application({ providers })",
    );
  });
});
