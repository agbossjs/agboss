/**
 * #533 AC4 — clock skew, in the process. Two instances on one lease store (in memory, and two
 * connections to one SQLite file), the taker's wall clock off by ± lease/2, ± lease and ± 10 × lease,
 * or one instance's clock 1 % fast or slow. The holder renews healthily for three minutes, then its
 * store stops answering it while the taker keeps asking. At every step of the real time:
 * - at most one live holder — the taker never holds the lease while the holder's fence says it is
 *   still its own, so no send of the holder leaves after the taker took over;
 * - a dead holder's lease is taken within the lease and the margin of its last renewal.
 *
 * The store deciding by its own clock (#533) keeps both in every scenario. Each scenario bites: the
 * same run on a store that decides by the caller's clock — what the PostgreSQL store did before #533
 * — breaks an invariant (an instance ahead: two holders; one behind: a late take; a drifting one:
 * either), and a holder 1 % slow with no safety margin outlives its lease.
 */
import { describe, expect, it } from "vitest";
import { InMemoryExecutionLeaseRepository } from "../../src/infrastructure/execution-lease.repository.js";
import type { ExecutionLeaseRepository } from "../../src/infrastructure/execution-lease.repository.js";
import { SqliteExecutionLeaseRepository } from "../../src/infrastructure/sqlite/sqlite-execution-lease.repository.js";
import type { Clock } from "../../src/infrastructure/clock.js";
import { ClockSkew } from "../../src/testing/clock-skew.js";
import { seconds, type Milliseconds } from "../../src/units/index.js";
import { storeTargets } from "../infrastructure/contracts/store-kinds.js";
import { HostClock, runSkew, StoreTime } from "./fixtures/lease-skew.js";

const kinds = storeTargets<ExecutionLeaseRepository>(
  ({ storeClock, application, database }) =>
    new InMemoryExecutionLeaseRepository(storeClock, application, database),
  ({ storeClock, application, connection }) =>
    new SqliteExecutionLeaseRepository(connection(), storeClock, application),
);

const LEASE = seconds(30);
const by = (times: number): Milliseconds => (LEASE * times) as Milliseconds;

/** A scenario: its name, each instance's skew, and the invariant the caller's clock breaks. */
interface Scenario {
  readonly name: string;
  readonly holder: ClockSkew;
  readonly taker: ClockSkew;
  readonly breaks: RegExp;
}

const TWO_HOLDERS = /two live holders/;
const LATE = /late take/;

const SCENARIOS: readonly Scenario[] = [
  ...[0.5, 1, 10].flatMap((times): Scenario[] => [
    {
      name: `the taker ${String(times)} × lease ahead`,
      holder: ClockSkew.none,
      taker: ClockSkew.ahead(by(times)),
      breaks: TWO_HOLDERS,
    },
    {
      name: `the taker ${String(times)} × lease behind`,
      holder: ClockSkew.none,
      taker: ClockSkew.behind(by(times)),
      breaks: LATE,
    },
  ]),
  {
    name: "the holder 1 % slow",
    holder: ClockSkew.drift(-0.01),
    taker: ClockSkew.none,
    breaks: TWO_HOLDERS,
  },
  {
    name: "the holder 1 % fast",
    holder: ClockSkew.drift(0.01),
    taker: ClockSkew.none,
    breaks: LATE,
  },
  {
    name: "the taker 1 % fast",
    holder: ClockSkew.none,
    taker: ClockSkew.drift(0.01),
    breaks: TWO_HOLDERS,
  },
  {
    name: "the taker 1 % slow",
    holder: ClockSkew.none,
    taker: ClockSkew.drift(-0.01),
    breaks: LATE,
  },
];

describe.each(kinds)("#533 AC4: clock skew on the $name lease store", (target) => {
  describe.each(SCENARIOS)("$name", ({ holder, taker, breaks }) => {
    it("the store's clock decides: one live holder at every step, no send after the take, the take on time", async () => {
      const run = await runSkew(target, { holder, taker, time: StoreTime.Store });

      expect(run.violations).toEqual([]);
      expect(run.takenAt).toBeDefined();
      expect(run.sends.every((sentAt) => sentAt < (run.takenAt ?? 0))).toBe(true);
    });

    it("bites: on the caller's clock the same run breaks an invariant", async () => {
      const run = await runSkew(target, { holder, taker, time: StoreTime.Caller });

      expect(run.violations.join("\n")).toMatch(breaks);
    });
  });

  it("bites: a holder 1 % slow with no safety margin outlives its lease on the store's clock", async () => {
    const holder = ClockSkew.drift(-0.01);
    const run = await runSkew(target, {
      holder,
      taker: ClockSkew.none,
      time: StoreTime.Store,
      margin: 0 as Milliseconds,
    });

    expect(run.violations.join("\n")).toMatch(TWO_HOLDERS);
  });

  it("the holder's host suspended for two leases (its monotonic clock stopped, the store's time on): its wall count ends its fence — one live holder", async () => {
    const host = {
      clock: (base: Clock) => new HostClock(base),
      event: (clock: HostClock) => {
        clock.suspend(by(2));
      },
    };
    const run = await runSkew(target, {
      holder: ClockSkew.none,
      taker: ClockSkew.none,
      time: StoreTime.Store,
      host,
    });

    expect(run.violations).toEqual([]);
  });

  it("bites: a fence on the monotonic count alone (the wall clock stopped with it) outlives the lease through the suspend", async () => {
    const host = {
      clock: (base: Clock) => new HostClock(base, true),
      event: (clock: HostClock) => {
        clock.suspend(by(2));
      },
    };
    const run = await runSkew(target, {
      holder: ClockSkew.none,
      taker: ClockSkew.none,
      time: StoreTime.Store,
      host,
    });

    expect(run.violations.join("\n")).toMatch(TWO_HOLDERS);
  });

  it.each([
    ["back", 0 - by(2)],
    ["forward", by(2)],
  ])(
    "the holder's wall clock stepped %s by two leases mid-lease: one live holder, the take on time",
    async (_, step) => {
      const host = {
        clock: (base: Clock) => new HostClock(base),
        event: (clock: HostClock) => {
          clock.stepWall(step);
        },
      };
      const run = await runSkew(target, {
        holder: ClockSkew.none,
        taker: ClockSkew.none,
        time: StoreTime.Store,
        host,
      });

      expect(run.violations).toEqual([]);
    },
  );

  it("each answer of the holder's store 5 s on its way back: the fence counts from the request, one live holder", async () => {
    const run = await runSkew(target, {
      holder: ClockSkew.drift(-0.01),
      taker: ClockSkew.none,
      time: StoreTime.Store,
      answerDelay: seconds(5),
    });

    expect(run.violations).toEqual([]);
  });
});
