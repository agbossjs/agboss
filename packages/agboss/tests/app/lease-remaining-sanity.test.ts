/**
 * #533 review H2 — the holder never trusts a `remaining` it cannot use: a store on the contract
 * before #533 (no `remaining`, a `renew` answering `true`), `NaN`, `Infinity` or a negative time is
 * 0 — the holder fails closed, its fence over at once —, and more than it asked for is the lease it
 * asked for: with its store down from then on, it stops 29 s later, never after.
 */
import { describe, expect, it } from "vitest";
import { executionLeasesOf } from "../../src/app/execution-leases.js";
import { ExecutionLeaseLostError } from "../../src/app/lease-lost.js";
import { NO_ENVIRONMENT_VALUES } from "../../src/environments/resolve.js";
import { applicationContextOf } from "../../src/flow/context/application-context.js";
import {
  InMemoryExecutionLeaseRepository,
  type ExecutionLease,
  type ExecutionLeaseRepository,
} from "../../src/infrastructure/execution-lease.repository.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { seconds, type Milliseconds } from "../../src/units/index.js";

const TREE = { tenantId: "default", rootExecutionId: "root-1" };

/** The in-memory store, its answers' `remaining` replaced by `answer`, its renewals failing once `down`. */
function storeAnswering(clock: VirtualClock, answer: unknown) {
  const store = new InMemoryExecutionLeaseRepository(
    clock,
    applicationContextOf({
      ...{ name: "sanity-application", version: "1.0.0", instanceId: "instance-1" },
      ...{ startedAt: clock.now(), environmentName: "test", environment: NO_ENVIRONMENT_VALUES },
    }),
    new InMemoryDatabase(),
  );
  const state = { down: false };
  const wrapped = Object.assign(Object.create(store) as ExecutionLeaseRepository, {
    acquire: async (tenantId: string, root: string, lease: Milliseconds) => {
      const taken = await store.acquire(tenantId, root, lease);
      // a store that breaks the contract: what it answers is not checked by the compiler
      return taken === undefined ? undefined : ({ ...taken, remaining: answer } as ExecutionLease);
    },
    renew: async (lease: ExecutionLease, length: Milliseconds) => {
      if (state.down) throw new Error("the lease store does not answer");
      return (await store.renew(lease, length)) === undefined ? undefined : answer;
    },
  });
  return { store: wrapped, state };
}

const FAILS_CLOSED: readonly (readonly [string, unknown])[] = [
  ["no remaining (a store before #533)", undefined],
  ["NaN", Number.NaN],
  ["a negative time", -5000],
  ["true (a renew before #533)", true],
  ["Infinity", Number.POSITIVE_INFINITY],
];

describe("#533 review H2: a remaining the holder cannot use", () => {
  it.each(FAILS_CLOSED)(
    "%s: the holder's fence is over at once — it fails closed",
    async (_, answer) => {
      const clock = new VirtualClock();
      const { store } = storeAnswering(clock, answer);
      const held = await executionLeasesOf(store, clock).hold(TREE);

      expect(() => {
        held.assertHeld();
      }).toThrow(ExecutionLeaseLostError);
      await held.release();
    },
  );

  it.each([
    ["ten times the lease", seconds(300)],
    ["a lease and a millisecond", seconds(30.001)],
  ])(
    "%s: trusted as the lease asked for, no longer — the store down, the holder stops 29 s later",
    async (_, answer) => {
      const clock = new VirtualClock();
      const { store, state } = storeAnswering(clock, answer);
      const held = await executionLeasesOf(store, clock).hold(TREE);
      state.down = true;

      await clock.advance(seconds(28.999));
      const isAliveBefore = !held.signal.aborted;
      await clock.advance(seconds(0.001));

      expect(isAliveBefore).toBe(true);
      expect(held.signal.reason).toBeInstanceOf(ExecutionLeaseLostError);
      await held.release();
    },
  );
});
