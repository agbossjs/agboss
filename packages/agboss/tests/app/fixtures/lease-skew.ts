/**
 * #533 AC4 — the skew harness: a holder and a taker on one lease store, each instance on its own
 * clock (`SkewedClock` over the test's `VirtualClock`, the "real" time), the store deciding expiry
 * either by its own time (the store clock: the test's clock — what a database's clock is) or, as
 * before #533, by the caller's clock. The holder renews as the framework's holder does, then its
 * store stops answering it; the taker asks for the lease every step. The invariants are checked at
 * every step of the real time, and the run reports what broke.
 */
import { executionLeasesOf, type HeldExecutionLease } from "../../../src/app/execution-leases.js";
import { EXECUTION_LEASE, LEASE_SAFETY_MARGIN } from "../../../src/app/lease-fence.js";
import { NO_ENVIRONMENT_VALUES } from "../../../src/environments/resolve.js";
import { applicationContextOf } from "../../../src/flow/context/application-context.js";
import { TestStoreClock, type Clock } from "../../../src/infrastructure/clock.js";
import type {
  ExecutionLease,
  ExecutionLeaseRepository,
} from "../../../src/infrastructure/execution-lease.repository.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { ClockSkew, SkewedClock } from "../../../src/testing/clock-skew.js";
import type { ContractTarget } from "../../../src/testing/contracts/seam.js";
import { seconds, type Milliseconds } from "../../../src/units/index.js";

/** Whose clock the store decides expiry by. */
export enum StoreTime {
  /** The store's own (#533): one clock for every instance, the database's. */
  Store = "the store's clock",
  /** The calling instance's (the design before #533). */
  Caller = "the caller's clock",
}

/** One scenario: each instance's skew, whose clock the store reads, the holder's margin. */
export interface SkewScenario {
  readonly holder: ClockSkew;
  readonly taker: ClockSkew;
  readonly time: StoreTime;
  readonly margin?: Milliseconds;
}

/** What one run saw: every broken invariant, and when the taker took the lease. */
export interface SkewRun {
  /** "two live holders at 12.3 s", "a send after the holder's fence at …", "late take …". */
  readonly violations: readonly string[];
  /** The holder's sends, each at its real time (ms after the start). */
  readonly sends: readonly number[];
  /** When the taker took the lease (ms after the start); undefined: it never did. */
  readonly takenAt: number | undefined;
}

/** How long the holder is healthy: long enough for a 1 % drift to add up to 1.8 s. */
const HEALTHY = seconds(180);
/** How long the run goes on once the holder's store stopped answering it. */
const STALLED = seconds(45);
/** The step of the real time in each phase. */
const HEALTHY_STEP = seconds(0.5);
const STALLED_STEP = seconds(0.1);
const TREE = { tenantId: "default", rootExecutionId: "root-1" };

const contextOf = (instanceId: string, clock: Clock) =>
  applicationContextOf({
    ...{ name: "skew-application", version: "1.0.0", instanceId, startedAt: clock.now() },
    ...{ environmentName: "test", environment: NO_ENVIRONMENT_VALUES },
  });

/** The holder's store: its renewals, once `isDown`, fail as an unreachable store's do. */
function reachable(
  store: ExecutionLeaseRepository,
  state: { isDown: boolean; renewedAt: number[] },
  base: Clock,
) {
  return Object.assign(Object.create(store) as ExecutionLeaseRepository, {
    renew: async (lease: ExecutionLease, length: Milliseconds) => {
      if (state.isDown) throw new Error("the lease store does not answer");
      const renewed = await store.renew(lease, length);
      if (renewed !== undefined) state.renewedAt.push(base.now().getTime());
      return renewed;
    },
  });
}

/** Whether the holder trusts its lease now (its fence, on its own clock); never throws. */
const isLive = (held: HeldExecutionLease): boolean => {
  try {
    held.assertHeld();
    return true;
  } catch {
    return false;
  }
};

/** Runs `scenario` on `target`'s store; the instances' clocks skewed over one real time. */
export async function runSkew(
  target: ContractTarget<ExecutionLeaseRepository>,
  scenario: SkewScenario,
): Promise<SkewRun> {
  const base = new VirtualClock();
  const start = base.now().getTime();
  const at = (): number => base.now().getTime() - start;
  await target.reset?.();
  const holderClock = new SkewedClock(base, scenario.holder);
  const takerClock = new SkewedClock(base, scenario.taker);
  const storeTime = (own: Clock) =>
    new TestStoreClock(scenario.time === StoreTime.Store ? base : own);
  const build = (instanceId: string, clock: Clock) =>
    target.instance({
      clock,
      storeClock: storeTime(clock),
      instanceId,
      application: contextOf(instanceId, clock),
    });
  const state = { isDown: false, renewedAt: [at()] };
  const holderStore = reachable(await build("instance-1", holderClock), state, base);
  const taker = await build("instance-2", takerClock);
  const margin = scenario.margin ?? LEASE_SAFETY_MARGIN;
  const held = await executionLeasesOf(holderStore, holderClock, { safetyMargin: margin }).hold(
    TREE,
  );
  const run = {
    violations: [] as string[],
    sends: [] as number[],
    takenAt: undefined as number | undefined,
  };
  const step = async (by: Milliseconds): Promise<void> => {
    await base.advance(by);
    const holderLive = isLive(held);
    if (holderLive) run.sends.push(at());
    if (
      run.takenAt === undefined &&
      (await taker.acquire(TREE.tenantId, TREE.rootExecutionId, EXECUTION_LEASE)) !== undefined
    )
      run.takenAt = at();
    if (run.takenAt !== undefined && holderLive)
      run.violations.push(`two live holders at ${String(at() / 1000)} s`);
  };
  for (let time = 0; time < HEALTHY; time += HEALTHY_STEP) await step(HEALTHY_STEP);
  state.isDown = true;
  for (let time = 0; time < STALLED; time += STALLED_STEP) await step(STALLED_STEP);
  const lastRenewal = Math.max(...state.renewedAt.map((value) => value - start));
  const due = lastRenewal + EXECUTION_LEASE + LEASE_SAFETY_MARGIN;
  if (run.takenAt === undefined || run.takenAt > due)
    run.violations.push(
      `late take: at ${String((run.takenAt ?? Infinity) / 1000)} s, due by ${String(due / 1000)} s`,
    );
  await held.release().catch(() => undefined);
  return run;
}
