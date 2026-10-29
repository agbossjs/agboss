import { NO_ENVIRONMENT_VALUES } from "../../environments/resolve.js";
import {
  applicationContextOf,
  type ApplicationContext,
} from "../../flow/context/application-context.js";
import type { Clock } from "../../infrastructure/clock.js";
import { TEST_START, VirtualClock } from "../clock.js";

/**
 * The seam between a published contract suite (#481) and the store under test: what one
 * application instance's store is built from, how a target builds it, and the lifecycle of one
 * case — the suite's clock, an empty backing store, two instances on it, then their close.
 */

/** What one instance's store is built from: the framework's clock and this instance's identity. */
export interface StoreSeam {
  /** The suite's clock (a VirtualClock): the store must read time from it, never from the database. */
  readonly clock: Clock;
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

/** What one case gets: the suite's clock and the stores of the two instances, on one backing store. */
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

/** The seam of `instanceId`, on the case's clock. */
const seamOf = (clock: VirtualClock, instanceId: string): StoreSeam => ({
  clock,
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
): Promise<ContractInstances<TStore>> {
  const built = async (instanceId: string): Promise<TStore> => {
    const store = await target.instance(seamOf(clock, instanceId));
    stores.push(store);
    return store;
  };
  const first = await built(FIRST_INSTANCE);
  const second = await built(SECOND_INSTANCE);
  return { clock, first, second };
}

/**
 * One case's lifecycle: a new `VirtualClock` at `2026-01-05T09:00:00.000Z` → `reset()` → two
 * `instance()` calls → the case → `close()` for each built store. A failing `reset()` fails the
 * case with its error and builds nothing; the case's own error wins over a failing `close()`.
 */
export function withTarget<TStore>(
  target: ContractTarget<TStore>,
  body: ContractCaseBody<TStore>,
): () => Promise<void> {
  return async () => {
    const clock = new VirtualClock(new Date(TEST_START));
    await target.reset?.();
    const stores: TStore[] = [];
    let outcome: { readonly error: unknown } | undefined;
    try {
      await body(await buildInstances(target, clock, stores));
    } catch (error) {
      outcome = { error };
    }
    const closeFailures = await closeAll(target, stores);
    if (outcome !== undefined) throw outcome.error;
    if (closeFailures.length > 0) throw closeFailures[0];
  };
}
