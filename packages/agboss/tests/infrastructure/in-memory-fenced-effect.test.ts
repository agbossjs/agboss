/**
 * #500 — what the in-memory fenced-effect store and the contract's base class do beyond the
 * published contract: the high-water mark refuses a lower token even when the lease's epoch matches
 * it (a wiped lease store), a lease taken over while an asynchronous write ran refuses its commit,
 * the sweep removes the marks too, a key made by hand is checked, and the store refuses to run
 * beside another lease store (`FencedEffectStoreMismatchError`).
 */
import { describe, expect, it } from "vitest";
import { ExecutionFencedError } from "../../src/app/lease-lost.js";
import { applicationContextOf } from "../../src/flow/context/application-context.js";
import { NO_ENVIRONMENT_VALUES } from "../../src/environments/resolve.js";
import {
  ExecutionLeaseRepository,
  InMemoryExecutionLeaseRepository,
} from "../../src/infrastructure/execution-lease.repository.js";
import { FencedEffectSettings } from "../../src/infrastructure/fenced-effect-settings.js";
import { FencedEffectStatus } from "../../src/infrastructure/fenced-effect.repository.js";
import { InMemoryDatabase, treeKeyOf } from "../../src/infrastructure/in-memory-database.js";
import {
  FencedEffectStoreMismatchError,
  InMemoryFencedEffectRepository,
} from "../../src/infrastructure/in-memory-fenced-effect.repository.js";
import { keyOf } from "../../src/testing/contracts/fenced-effect-data.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { hours, seconds } from "../../src/units/index.js";

/** One instance's stores over a database of the test. */
function storesOn(database = new InMemoryDatabase(), clock = new VirtualClock()) {
  const application = applicationContextOf({
    name: "fenced-application",
    version: "1.0.0",
    instanceId: "instance-1",
    startedAt: clock.now(),
    environmentName: "test",
    environment: NO_ENVIRONMENT_VALUES,
  });
  const leases = new InMemoryExecutionLeaseRepository(clock, application, database);
  const settings = new FencedEffectSettings();
  const effects = new InMemoryFencedEffectRepository(clock, database, settings, leases);
  return { clock, database, leases, effects };
}

async function held(leases: ExecutionLeaseRepository, executionId = "execution-1") {
  const lease = await leases.acquire("default", executionId, hours(1));
  if (lease === undefined) throw new Error("the lease is held");
  return lease;
}

const receipt = (text: string) => () => ({ receipt: text });

/** A lease store of another database (what a listed SQLite one is to the in-memory store). */
class ElsewhereExecutionLeaseRepository extends ExecutionLeaseRepository {
  ping(): Promise<void> {
    return Promise.resolve();
  }
  acquire(): Promise<undefined> {
    return Promise.resolve(undefined);
  }
  renew(): Promise<boolean> {
    return Promise.resolve(false);
  }
  release(): Promise<void> {
    return Promise.resolve();
  }
  finish(): Promise<void> {
    return Promise.resolve();
  }
  yield(): Promise<boolean> {
    return Promise.resolve(false);
  }
  reclaim(): Promise<undefined> {
    return Promise.resolve(undefined);
  }
}

describe("#500: the in-memory fenced-effect store", () => {
  it("AC2: a token below the scope's mark is refused even when the lease's epoch is that token", async () => {
    const { database, leases, effects } = storesOn();
    await held(leases);
    // the lease store wiped (its epochs count from 1 again), the scope's mark kept at 2
    database.executionLeases.delete(treeKeyOf("default", "execution-1"));
    database.fencedEffectMarks.set("default:execution-1", { highestToken: 2, storedAt: 0 });
    const again = await held(leases);

    const refused = await effects
      .saveResultIfAbsent(keyOf(again), receipt("r1"))
      .catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(ExecutionFencedError);
    expect(refused).toMatchObject({ token: 1, observedToken: 2 });
    expect(database.fencedEffectResults.size).toBe(0);
  });

  it("AC2: a lease taken over while an asynchronous write ran refuses its commit: nothing applied", async () => {
    const { clock, database, leases, effects } = storesOn();
    const lease = await leases.acquire("default", "execution-1", seconds(30));
    if (lease === undefined) throw new Error("the lease is held");
    const other = storesOn(database, clock);
    let isApplied = false;

    const call = effects.saveResultIfAbsent(keyOf(lease), async (transaction) => {
      transaction.onCommit(() => {
        isApplied = true;
      });
      await clock.advance(seconds(31));
      await held(other.leases);
      return { receipt: "late" };
    });

    await expect(call).rejects.toMatchObject({ token: 1, observedToken: 2 });
    expect(isApplied).toBe(false);
    expect(database.fencedEffectResults.size).toBe(0);
    expect(database.fencedEffectMarks.size).toBe(0);
  });

  it("the sweep's deletion removes a scope's mark stored before the cutoff, and keeps a later one", async () => {
    const { clock, database, leases, effects } = storesOn();
    await effects.saveResultIfAbsent(keyOf(await held(leases)), receipt("a"));
    await clock.advance(seconds(60));
    await effects.saveResultIfAbsent(keyOf(await held(leases, "execution-2")), receipt("b"));

    await effects.deleteByStoredAtBefore(new Date(clock.now().getTime() - seconds(30)));

    expect([...database.fencedEffectMarks.keys()]).toEqual(["default:execution-2"]);
  });

  it("calls on two keys of one scope wait for each other and both run", async () => {
    const { leases, effects } = storesOn();
    const lease = await held(leases);

    const outcomes = await Promise.all([
      effects.saveResultIfAbsent(keyOf(lease, "charge"), receipt("a")),
      effects.saveResultIfAbsent(keyOf(lease, "notify"), receipt("b")),
    ]);

    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      FencedEffectStatus.Ran,
      FencedEffectStatus.Ran,
    ]);
  });

  it("refuses to run beside another lease store: FencedEffectStoreMismatchError names both", async () => {
    const { clock, database, leases } = storesOn();
    const effects = new InMemoryFencedEffectRepository(
      clock,
      database,
      new FencedEffectSettings(),
      new ElsewhereExecutionLeaseRepository(),
    );

    const refused = effects.saveResultIfAbsent(keyOf(await held(leases)), receipt("a"));

    await expect(refused).rejects.toBeInstanceOf(FencedEffectStoreMismatchError);
    await expect(refused).rejects.toMatchObject({
      fencedEffectRepository: "InMemoryFencedEffectRepository",
      leaseRepository: "ElsewhereExecutionLeaseRepository",
    });
    expect(database.fencedEffectResults.size).toBe(0);
  });
});

describe("#500: a fenced-effect key made by hand is checked", () => {
  for (const [problem, change, message] of [
    ["a scope key of other parts", { scopeKey: "default:execution-2" }, /is not the scope of/],
    ["a token below 1", { token: 0 }, /not a lease epoch/],
    ["a fractional token", { token: 1.5 }, /not a lease epoch/],
    ["an empty name", { name: "" }, /must not be empty/],
    ["an empty idempotency key", { idempotencyKey: "" }, /must not be empty/],
  ] as const) {
    it(`${problem} is refused before anything runs`, async () => {
      const { leases, effects } = storesOn();
      let runs = 0;

      const call = effects.saveResultIfAbsent({ ...keyOf(await held(leases)), ...change }, () => {
        runs += 1;
        return null;
      });

      await expect(call).rejects.toThrow(message);
      await expect(call).rejects.toBeInstanceOf(TypeError);
      expect(runs).toBe(0);
    });
  }
});
