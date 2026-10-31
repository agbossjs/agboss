/**
 * #533 item 3 — the in-memory fenced-effect store and the contract's base class at their edges: the
 * transactions of one scope wait for each other even when a write is asynchronous, and each scope's
 * lock is gone once its last transaction settled; a result and a mark stored at the sweep's cutoff
 * are kept; the scope's mark is the highest token that wrote or replayed it; a step's replay names
 * no origin; the entry checks run in their order (name, business key, the key's shape) and a key's
 * join is its own; a result of exactly `maxResultSize` bytes is stored.
 */
import { describe, expect, it } from "vitest";
import { ExecutionFencedError } from "../../src/app/lease-lost.js";
import { NO_ENVIRONMENT_VALUES } from "../../src/environments/resolve.js";
import { applicationContextOf } from "../../src/flow/context/application-context.js";
import {
  ExecutionLeaseRepository,
  InMemoryExecutionLeaseRepository,
} from "../../src/infrastructure/execution-lease.repository.js";
import {
  InvalidBusinessKeyError,
  InvalidFencedEffectNameError,
} from "../../src/infrastructure/fenced-effect-key.js";
import { FencedEffectSettings } from "../../src/infrastructure/fenced-effect-settings.js";
import { FencedEffectStatus } from "../../src/infrastructure/fenced-effect.repository.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import {
  FencedEffectStoreMismatchError,
  InMemoryFencedEffectRepository,
} from "../../src/infrastructure/in-memory-fenced-effect.repository.js";
import { keyOf } from "../../src/testing/contracts/fenced-effect-data.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { hours, type Bytes } from "../../src/units/index.js";

/** One instance's stores over a new database. */
function storesOn(settings = new FencedEffectSettings()) {
  const clock = new VirtualClock();
  const database = new InMemoryDatabase();
  const application = applicationContextOf({
    ...{ name: "fenced-application", version: "1.0.0", instanceId: "instance-1" },
    ...{ startedAt: clock.now(), environmentName: "test", environment: NO_ENVIRONMENT_VALUES },
  });
  const leases = new InMemoryExecutionLeaseRepository(clock, application, database);
  const effects = new InMemoryFencedEffectRepository(clock, database, settings, leases);
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
      effects.saveResultIfAbsent(keyOf(lease, "charge"), startedAt(started, "charge", gate.passed)),
      effects.saveResultIfAbsent(keyOf(lease, "notify"), startedAt(started, "notify")),
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
    const one = effects.saveResultIfAbsent(
      keyOf(lease, "a"),
      startedAt(started, "a", first.passed),
    );
    const two = effects.saveResultIfAbsent(
      keyOf(lease, "b"),
      startedAt(started, "b", second.passed),
    );
    first.open();
    await one;
    await settled();

    const three = effects.saveResultIfAbsent(keyOf(lease, "c"), startedAt(started, "c"));
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

    await effects.saveResultIfAbsent(keyOf(lease), () => ({ receipt: "r" }));
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

    await effects.saveResultIfAbsent(keyOf(lease), () => ({ receipt: "r" }));

    expect(database.fencedEffectMarks.get(keyOf(lease).scopeKey)?.highestToken).toBe(1);
  });

  it("a replay under a newer token raises the mark to it", async () => {
    const { database, leases, effects } = storesOn();
    const first = await held(leases);
    await effects.saveResultIfAbsent(keyOf(first), () => ({ receipt: "r" }));
    await leases.release(first);
    const second = await held(leases);

    const replay = await effects.saveResultIfAbsent(keyOf(second), () => ({ receipt: "again" }));

    expect(replay.status).toBe(FencedEffectStatus.Replayed);
    expect(database.fencedEffectMarks.get(keyOf(second).scopeKey)?.highestToken).toBe(2);
  });

  it("a result and a mark stored exactly at the cutoff are kept", async () => {
    const { clock, database, leases, effects } = storesOn();
    await effects.saveResultIfAbsent(keyOf(await held(leases)), () => ({ receipt: "r" }));

    await effects.deleteByStoredAtBefore(clock.now());

    expect([database.fencedEffectResults.size, database.fencedEffectMarks.size]).toEqual([1, 1]);
  });

  it("a step's replay names no origin: the outcome has no replayedFrom at all", async () => {
    const { leases, effects } = storesOn();
    const key = keyOf(await held(leases));
    await effects.saveResultIfAbsent(key, () => ({ receipt: "r" }));

    const replay = await effects.saveResultIfAbsent(key, () => ({ receipt: "again" }));

    expect(replay).toStrictEqual({
      status: FencedEffectStatus.Replayed,
      result: { receipt: "r" },
      token: 1,
    });
  });
});

describe("#533: the base class's entry checks", () => {
  it("the name first: a bad name and a bad business key is InvalidFencedEffectNameError", async () => {
    const { leases, effects } = storesOn();
    const key = { ...keyOf(await held(leases)), name: "no spaces", businessKey: "a\u0001b" };

    await expect(effects.saveResultIfAbsent(key, () => ({}))).rejects.toBeInstanceOf(
      InvalidFencedEffectNameError,
    );
  });

  it("then the business key: a bad one with a bad scope is InvalidBusinessKeyError", async () => {
    const { leases, effects } = storesOn();
    const key = { ...keyOf(await held(leases)), scopeKey: "other:scope", businessKey: "a\u0001b" };

    await expect(effects.saveResultIfAbsent(key, () => ({}))).rejects.toBeInstanceOf(
      InvalidBusinessKeyError,
    );
  });

  it("a key whose scope does not match its parts is an InvalidFencedEffectKeyError", async () => {
    const { leases, effects } = storesOn();
    const key = { ...keyOf(await held(leases)), scopeKey: "other:scope" };

    await expect(effects.saveResultIfAbsent(key, () => ({}))).rejects.toMatchObject({
      name: "InvalidFencedEffectKeyError",
      message: expect.stringContaining("not a fenced effect key") as unknown,
    });
  });

  it("two keys whose parts run together are not one join: each runs its own transaction", async () => {
    const { leases, effects } = storesOn();
    const first = await held(leases);
    await leases.release(first);
    const lease = await held(leases);
    // "charge" at token 12 and "charge1" at token 2 read alike without a separator between the parts
    const stale = { ...keyOf(lease, "charge"), token: 12 };

    const [refused, ran] = await Promise.allSettled([
      effects.saveResultIfAbsent(stale, () => ({ receipt: "stale" })),
      effects.saveResultIfAbsent(keyOf(lease, "charge1"), () => ({ receipt: "ran" })),
    ]);

    expect(refused).toMatchObject({ status: "rejected", reason: expect.any(ExecutionFencedError) });
    expect(ran).toMatchObject({ status: "fulfilled", value: { status: FencedEffectStatus.Ran } });
  });

  it("a result of exactly maxResultSize bytes is stored", async () => {
    const result = { receipt: "r" };
    const size = Buffer.byteLength(JSON.stringify(result), "utf8") as Bytes;
    const { leases, effects } = storesOn(new FencedEffectSettings({ maxResultSize: size }));

    const outcome = await effects.saveResultIfAbsent(keyOf(await held(leases)), () => result);

    expect(outcome.status).toBe(FencedEffectStatus.Ran);
  });
});

describe("#533: a store beside another lease store", () => {
  it("FencedEffectStoreMismatchError names both stores and the fix", () => {
    const error = new FencedEffectStoreMismatchError({
      fencedEffectRepository: "InMemoryFencedEffectRepository",
      leaseRepository: "SqliteExecutionLeaseRepository",
      expectedLeaseRepository: "InMemoryExecutionLeaseRepository",
    });

    expect(error.name).toBe("FencedEffectStoreMismatchError");
    expect(error.message).toBe(
      "InMemoryFencedEffectRepository checks the leases of InMemoryExecutionLeaseRepository, but the application's leases are in SqliteExecutionLeaseRepository: list the fenced-effect store of that lease store's database in @Application({ providers })",
    );
  });
});
