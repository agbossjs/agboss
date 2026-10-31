import { NO_ENVIRONMENT_VALUES } from "../../environments/resolve.js";
import {
  applicationContextOf,
  type ApplicationContext,
} from "../../flow/context/application-context.js";
import {
  DatabaseStoreClock,
  systemClock,
  TestStoreClock,
  type Clock,
  type StoreClock,
} from "../../infrastructure/clock.js";
import { TEST_START, VirtualClock } from "../clock.js";
import { ClockSkew, SkewedClock } from "../clock-skew.js";
import { trackedStore } from "./tracked-store.js";

/**
 * The seam between a published contract suite (#481) and the store under test: what one
 * application instance's store is built from, how a target builds it, and the lifecycle of one
 * case — the suite's clock, an empty backing store, two instances on it, then their close.
 */

/** What one instance's store is built from: the clocks and this instance's identity. */
export interface StoreSeam {
  /**
   * The instance's own clock: the suite's `VirtualClock` — or, in a case of the store's time as the
   * authority (#533), the real time skewed for this instance, which a store must not decide by.
   */
  readonly clock: Clock;
  /**
   * The time the store decides expiry by (#533): the suite's clock injected (`isDatabaseTime`
   * false — every store reads it), or in database mode the database's own (`isDatabaseTime` true: a
   * networked store reads its database's clock in each statement; in-memory and SQLite `now()`, the
   * host's, shared by both instances).
   */
  readonly storeClock: StoreClock;
  /** "instance-1" or "instance-2": the holder of leases, the claimer of queued children. */
  readonly instanceId: string;
  /** The instance's application context (its instanceId, a test environment). */
  readonly application: ApplicationContext;
}

/** The store under test: how to build one instance of it, and how to start every test from empty. */
export interface ContractTarget<TStore> {
  /** Shown in the suite title: "PostgreSQL". */
  readonly name: string;
  /** Builds one instance's store. Called twice per test (two instances on one backing store). */
  instance(seam: StoreSeam): TStore | Promise<TStore>;
  /** Before each test: an empty backing store (truncate, a new schema, a new file). */
  reset?(): void | Promise<void>;
  /** After each test, per built instance: close connections. */
  close?(store: TStore): void | Promise<void>;
}

/**
 * What one case gets: the suite's clock and the stores of the two instances, on one backing store —
 * each store's calls tracked on the clock, so `advance` lets a database round trip finish (#511).
 */
export interface ContractInstances<TStore> {
  /** The clock both stores were built on: time moves only by `clock.advance`. */
  readonly clock: VirtualClock;
  /** The store of "instance-1": the one a case with a single instance uses. */
  readonly first: TStore;
  /** The store of "instance-2". */
  readonly second: TStore;
}

/** The body of one contract case. */
export type ContractCaseBody<TStore> = (instances: ContractInstances<TStore>) => Promise<void>;

/** The instances of every case, built in this order. */
const FIRST_INSTANCE = "instance-1";
const SECOND_INSTANCE = "instance-2";

/**
 * How a case runs (#533): on the suite's `VirtualClock`, the stores' time injected (the default), or
 * on real time with the stores deciding by their database's time and the second instance's own clock
 * skewed — so a store that reads the caller's clock fails it.
 */
export interface DatabaseTime {
  readonly secondSkew: ClockSkew;
}

/** The host's real time, the one clock a database-time case's stores share (#533). */
const DATABASE_TIME: StoreClock = new DatabaseStoreClock(systemClock);

/** The seam of `instanceId`, on the case's clock (or, in database time, on its skewed real clock). */
const seamOf = (clock: VirtualClock, instanceId: string, time?: DatabaseTime): StoreSeam => ({
  ...(time === undefined
    ? { clock, storeClock: new TestStoreClock(clock) }
    : {
        clock: new SkewedClock(
          systemClock,
          instanceId === FIRST_INSTANCE ? ClockSkew.none : time.secondSkew,
        ),
        storeClock: DATABASE_TIME,
      }),
  instanceId,
  application: applicationContextOf({
    name: "contract-test-application",
    version: "1.0.0",
    instanceId,
    startedAt: clock.now(),
    environmentName: "test",
    environment: NO_ENVIRONMENT_VALUES,
  }),
});

/** Closes every built store; the errors of the closes that failed, in order. */
async function closeAll<TStore>(
  target: ContractTarget<TStore>,
  stores: readonly TStore[],
): Promise<unknown[]> {
  const failures: unknown[] = [];
  for (const store of stores) {
    try {
      await target.close?.(store);
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

/** Builds the two instances' stores into `stores` (so the ones built are closed if one fails). */
async function buildInstances<TStore>(
  target: ContractTarget<TStore>,
  clock: VirtualClock,
  stores: TStore[],
  time: DatabaseTime | undefined,
): Promise<ContractInstances<TStore>> {
  const built = async (instanceId: string): Promise<TStore> => {
    const store = await target.instance(seamOf(clock, instanceId, time));
    stores.push(store);
    // the case's clock waits for its calls: a networked store's round trip is more than one turn (#511)
    return trackedStore(store, clock);
  };
  const first = await built(FIRST_INSTANCE);
  const second = await built(SECOND_INSTANCE);
  return { clock, first, second };
}

/**
 * One case's lifecycle: a new `VirtualClock` at `2026-01-05T09:00:00.000Z` → `reset()` → two
 * `instance()` calls → the case → `close()` for each built store. A failing `reset()` fails the
 * case with its error and builds nothing; the case's own error wins over a failing `close()`. In
 * `time` (#533) the stores decide by the database's time on real time, the second instance skewed.
 */
export function withTarget<TStore>(
  target: ContractTarget<TStore>,
  body: ContractCaseBody<TStore>,
  time?: DatabaseTime,
): () => Promise<void> {
  return async () => {
    const clock = new VirtualClock(new Date(TEST_START));
    await target.reset?.();
    const stores: TStore[] = [];
    let outcome: { readonly error: unknown } | undefined;
    try {
      await body(await buildInstances(target, clock, stores, time));
    } catch (error) {
      outcome = { error };
    }
    const closeFailures = await closeAll(target, stores);
    if (outcome !== undefined) throw outcome.error;
    if (closeFailures.length > 0) throw closeFailures[0];
  };
}
