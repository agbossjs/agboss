/**
 * #762: the "store's time is the authority" cases (#533) run on real time, so a runner that stalls
 * at the wrong moment used to decide them: the caller-clock store passed "±0.5 × / 1 × lease behind"
 * once its second try came 250 / 650 ms late, and a correct store failed every case once its first
 * try came 350 ms late. Each attempt is now judged only when its measured schedule proves both
 * outcomes, else run again on a fresh tree — a stalled attempt decides nothing, and a case with no
 * timed attempt fails, never passes.
 */
import { describe, expect, it } from "vitest";
import type { ExecutionLeaseRepository } from "../../../src/index.js";
import {
  isTimed,
  LEASE_AUTHORITY_CASES,
} from "../../../src/testing/contracts/execution-lease-authority.cases.js";
import { withTarget, type StoreSeam } from "../../../src/testing/contracts/seam.js";
import {
  LeaseTable,
  MapExecutionLeaseRepository,
} from "../../fixtures/contracts/map-lease-store.js";

const span = (start: number, end = start + 2) => ({ start, end });

/** An attempt as planned: take at 0, renewal right after, tries at +500 and +1000 ms of it. */
const onTime = {
  take: span(0),
  renewal: span(2),
  whileLive: span(504),
  onceOver: span(1004),
};

describe("#762: an attempt is judged only on a schedule that proves both outcomes", () => {
  it("on time, every offset of the cases is timed", () => {
    for (const offset of [400, -400, 800, -800, 8000, -8000])
      expect(isTimed(onTime, offset)).toBe(true);
  });

  it("a first try that lands while the renewed lease may be over is untimed (a correct store would take it)", () => {
    const late = { ...onTime, whileLive: span(800) };
    for (const offset of [400, -400, 800, -800]) expect(isTimed(late, offset)).toBe(false);
  });

  it("a second try late enough for a caller ½ or 1 lease behind to see the lease over is untimed", () => {
    expect(isTimed({ ...onTime, onceOver: span(1250) }, -400)).toBe(false);
    expect(isTimed({ ...onTime, onceOver: span(1250) }, -800)).toBe(true);
    expect(isTimed({ ...onTime, onceOver: span(1650) }, -800)).toBe(false);
    expect(isTimed({ ...onTime, onceOver: span(1650) }, -8000)).toBe(true);
  });

  it("a second try still inside the renewed lease, or a renewal past the first lease, is untimed", () => {
    expect(isTimed({ ...onTime, onceOver: span(820) }, 800)).toBe(false);
    expect(isTimed({ ...onTime, renewal: span(2, 790) }, 8000)).toBe(false);
  });
});

/** Busy-waits: the runner frozen, as a loaded CI machine freezes a vitest worker. */
const freeze = (ms: number): void => {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // nothing runs meanwhile
  }
};

/** A lease store on the store's clock or the caller's, whose second instance freezes `ms` before its `at`-th take. */
function frozenTarget(isOnCallerClock: boolean, ms: number, at: number) {
  let table = new LeaseTable();
  return {
    name: isOnCallerClock
      ? "a lease store on the caller's clock"
      : "a lease store on the store's time",
    reset: () => {
      table = new LeaseTable();
    },
    instance: (seam: StoreSeam): ExecutionLeaseRepository => {
      const clock = isOnCallerClock ? seam.clock : seam.storeClock;
      const store = new MapExecutionLeaseRepository(table, clock, seam.application);
      if (seam.instanceId !== "instance-2") return store;
      let takes = 0;
      const acquire = store.acquire.bind(store);
      store.acquire = (...args: Parameters<typeof acquire>) => {
        takes += 1;
        if (takes === at) freeze(ms);
        return acquire(...args);
      };
      return store;
    },
  };
}

/** Whether `contractCase` passes on the target. */
async function passes(
  contractCase: (typeof LEASE_AUTHORITY_CASES)[number],
  target: ReturnType<typeof frozenTarget>,
): Promise<boolean> {
  try {
    await withTarget(target, contractCase.run, contractCase.databaseTime)();
    return true;
  } catch {
    return false;
  }
}

// the stalls the measurement of #762 found deciding the cases before the fix
const STALLS = [
  { ms: 650, at: 2, what: "the second try 650 ms late" },
  { ms: 400, at: 1, what: "the first try 400 ms late" },
];

describe("#762: a stalled attempt decides nothing", () => {
  for (const stall of STALLS)
    it(`with ${stall.what}: the caller-clock store fails every case, the store-time store passes every case`, async () => {
      const caller: boolean[] = [];
      const store: boolean[] = [];
      for (const contractCase of LEASE_AUTHORITY_CASES) {
        caller.push(await passes(contractCase, frozenTarget(true, stall.ms, stall.at)));
        store.push(await passes(contractCase, frozenTarget(false, stall.ms, stall.at)));
      }

      expect(caller).toEqual(LEASE_AUTHORITY_CASES.map(() => false));
      expect(store).toEqual(LEASE_AUTHORITY_CASES.map(() => true));
    }, 120_000);

  it("a runner stalled on every attempt fails the case — never a pass", async () => {
    let table = new LeaseTable();
    const target = {
      name: "always stalled",
      reset: () => {
        table = new LeaseTable();
      },
      instance: (seam: StoreSeam): ExecutionLeaseRepository => {
        const store = new MapExecutionLeaseRepository(table, seam.storeClock, seam.application);
        const acquire = store.acquire.bind(store);
        if (seam.instanceId === "instance-2")
          store.acquire = (...args: Parameters<typeof acquire>) => {
            freeze(400);
            return acquire(...args);
          };
        return store;
      },
    };
    const [halfAhead] = LEASE_AUTHORITY_CASES;

    await expect(
      withTarget(target, halfAhead?.run ?? (() => Promise.resolve()), halfAhead?.databaseTime)(),
    ).rejects.toThrow(/#762: no attempt of 10 ran on time/u);
  }, 120_000);
});
