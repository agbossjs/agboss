/**
 * #533 item 1: the explorer's search — a walk reproduces from its seed, a violation is cut down to
 * a minimal schedule and printed, a replay skips what is no longer possible, and the exhaustive
 * search of the core's in-memory stores finds nothing.
 */
import { describe, expect, it } from "vitest";
import { InMemoryExecutionLeaseRepository } from "../../../../src/infrastructure/execution-lease.repository.js";
import { InMemoryOutboundCallRepository } from "../../../../src/infrastructure/outbound-call.repository.js";
import {
  exhaustive,
  randomWalks,
  replayed,
  scheduleText,
  seededRandom,
} from "../../../../src/testing/contracts/explorer/search.js";
import {
  ExplorerInvariant,
  ExplorerWorldKind,
  LeaseOperation,
  TimeStep,
} from "../../../../src/testing/contracts/explorer/types.js";
import {
  callTarget,
  EXPLORED_SKEWS,
  skewText,
  worldOf,
} from "../../../../src/testing/contracts/explorer/worlds.js";
import { ClockSkew } from "../../../../src/testing/clock-skew.js";
import { seconds } from "../../../../src/units/index.js";
import { inMemoryOutboundCalls } from "../../../infrastructure/contracts/outbound-call-stores.js";
import { inMemoryTarget } from "../../../infrastructure/contracts/store-kinds.js";

const sound = callTarget(inMemoryTarget(inMemoryOutboundCalls));
const onCallerClock = callTarget(
  inMemoryTarget((seam) => {
    const leases = new InMemoryExecutionLeaseRepository(
      seam.clock,
      seam.application,
      seam.database,
    );
    return {
      calls: new InMemoryOutboundCallRepository(seam.storeClock, seam.database, leases),
      leases,
    };
  }),
);
const ahead = worldOf(ExplorerWorldKind.Lease, 2, ClockSkew.ahead(seconds(30)));

describe("#533: the interleaving explorer's search", () => {
  it("a seed gives the same numbers every time, another seed others", () => {
    const one = seededRandom(533);
    const again = seededRandom(533);
    const other = seededRandom(534);
    const first = [one(), one(), one()];

    expect([again(), again(), again()]).toEqual(first);
    expect([other(), other(), other()]).not.toEqual(first);
    expect(first.every((value) => value >= 0 && value < 1)).toBe(true);
  });

  it("a walk that breaks an invariant reproduces from its seed, cut down to its minimal schedule", async () => {
    const options = { runs: 20, depth: 12, seed: 533 };
    const found = await randomWalks(
      worldOf(ExplorerWorldKind.Lease, 3, EXPLORED_SKEWS[3] ?? ClockSkew.none),
      onCallerClock,
      options,
    );
    const again = await randomWalks(
      worldOf(ExplorerWorldKind.Lease, 3, EXPLORED_SKEWS[3] ?? ClockSkew.none),
      onCallerClock,
      options,
    );

    expect(found.violation?.violation.invariant).toBe(ExplorerInvariant.OneLiveHolder);
    expect(found.violation?.seed).toBe(533);
    expect(scheduleText("x", found.violation ?? never())).toBe(
      scheduleText("x", again.violation ?? never()),
    );
    expect(found.violation?.steps.length).toBeLessThanOrEqual(found.violation?.foundLength ?? 0);
  });

  it("an instance 30 s ahead on a store of the caller's clock: two takes, two live holders — two steps", async () => {
    const report = await exhaustive(ahead, onCallerClock, 4);

    const text = scheduleText("in-memory", report.violation ?? never());
    expect(text).toContain(
      "[one-live-holder] instance-2 was granted epoch 2 of tree-1 while instance-1 still trusts epoch 1",
    );
    expect(text).toContain("minimal schedule (2 of the");
    expect(text).toContain(
      "   1. instance-1 acquire tree-1 → epoch 1, 30000 ms left\n   2. instance-2 acquire tree-1 → epoch 2",
    );
    expect(text).toContain("exhaustive search");
  });

  it("a replay skips an action no longer possible: a renewal of a lease never taken", async () => {
    const run = await replayed(ahead, sound, [
      { kind: "lease", operation: LeaseOperation.Renew, instance: 1, tree: "tree-1" },
      { kind: "lease", operation: LeaseOperation.Acquire, instance: 1, tree: "tree-1" },
      { kind: "time", step: TimeStep.End },
      { kind: "lease", operation: LeaseOperation.Acquire, instance: 2, tree: "tree-1" },
    ]);

    expect(run.steps.map((step) => step.label)).toEqual([
      "→ epoch 1, 30000 ms left",
      "+30000 ms",
      "→ epoch 2, 30000 ms left, taken over from instance-1 at 1",
    ]);
    expect(run.observer.violations).toEqual([]);
  });

  it("the core's in-memory stores: every schedule of 2 instances, 6 steps deep, in each world — nothing", async () => {
    for (const kind of [ExplorerWorldKind.Lease, ExplorerWorldKind.OutboundCall]) {
      const report = await exhaustive(worldOf(kind, 2, ClockSkew.none), sound, 6);
      expect(report.violation).toBeUndefined();
      expect(report.states).toBeGreaterThan(10);
    }
  });

  it("names a skew by its offset", () => {
    expect(EXPLORED_SKEWS.map(skewText)).toEqual([
      "on time",
      "+15 s",
      "-15 s",
      "+30 s",
      "-30 s",
      "+300 s",
      "-300 s",
    ]);
  });
});

const never = (): never => {
  throw new Error("expected a violation");
};
