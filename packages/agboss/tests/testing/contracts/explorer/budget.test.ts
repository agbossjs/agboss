/**
 * #590: a search stops when its case is aborted — vitest times a case out and goes on, so a search
 * left running kept resetting the backing store under the next case (on PostgreSQL: epochs from 1
 * again inside a walk, a finished lease taken again, `deadlock detected`) — and at its time limit;
 * either way it says how far it got, and makes no store call after.
 */
import { describe, expect, it } from "vitest";
import {
  exhaustive,
  randomWalks,
  scheduleText,
  stopReasonOf,
} from "../../../../src/testing/contracts/explorer/search.js";
import {
  ExplorerWorldKind,
  type ExplorerStores,
} from "../../../../src/testing/contracts/explorer/types.js";
import { callTarget, worldOf } from "../../../../src/testing/contracts/explorer/worlds.js";
import type { ContractTarget } from "../../../../src/testing/contracts/index.js";
import { ClockSkew } from "../../../../src/testing/clock-skew.js";
import { inMemoryOutboundCalls } from "../../../infrastructure/contracts/outbound-call-stores.js";
import { BROKEN_CALL_TARGETS } from "../../../fixtures/contracts/explorer-broken-stores.js";
import { inMemoryTarget } from "../../../infrastructure/contracts/store-kinds.js";

/** The in-memory call target (or `calls`), counting the resets it is asked for (one per schedule). */
function counted(calls = inMemoryTarget(inMemoryOutboundCalls)): {
  readonly target: ContractTarget<ExplorerStores>;
  readonly resets: () => number;
} {
  const inner = callTarget(calls);
  let resets = 0;
  return {
    target: {
      ...inner,
      reset: async () => {
        resets += 1;
        await inner.reset?.();
      },
    },
    resets: () => resets,
  };
}

const world = worldOf(ExplorerWorldKind.Lease, 2, ClockSkew.none);

describe("#590: a search stops when its case is aborted or out of time, and says so", () => {
  it("aborted before it starts: no schedule, no reset — and the reason and what is left", async () => {
    const { target, resets } = counted();
    const aborted = AbortSignal.abort();

    const report = await exhaustive(world, target, 8, { signal: aborted });
    const walked = await randomWalks(
      world,
      target,
      { runs: 50, depth: 10, seed: 1 },
      { signal: aborted },
    );

    expect(report).toEqual({
      schedules: 0,
      states: 0,
      stopped: { left: 1, reason: "its case was aborted (timed out or cancelled)" },
    });
    expect(walked.stopped).toEqual({
      left: 50,
      reason: "its case was aborted (timed out or cancelled)",
    });
    expect(resets()).toBe(0);
  });

  it("aborted midway: the schedule in progress ends, then no store call — the next case's store is left alone", async () => {
    const { target, resets } = counted();
    const controller = new AbortController();
    const stopAfter = 5;
    const watched: ContractTarget<ExplorerStores> = {
      ...target,
      reset: async () => {
        await target.reset?.();
        if (resets() === stopAfter) controller.abort();
      },
    };

    const report = await exhaustive(world, watched, 8, { signal: controller.signal });
    const after = resets();
    await new Promise((resolve) => setImmediate(resolve));

    expect(report.schedules).toBe(stopAfter);
    expect(report.stopped?.left).toBeGreaterThan(0);
    expect(resets()).toBe(after);
  });

  it("past its deadline: stopped at the time limit, the counts kept", async () => {
    const { target } = counted();

    const report = await exhaustive(world, target, 8, { deadline: 0 });

    expect(report.stopped?.reason).toBe("it reached its time limit");
    expect(stopReasonOf({})).toBeUndefined();
  });
});

/** A store that grants one epoch twice: every search finds it and shrinks the schedule. */
const reusedEpoch = (): NonNullable<(typeof BROKEN_CALL_TARGETS)[string]> =>
  BROKEN_CALL_TARGETS["a reclaim that keeps the epoch"] ?? never();

const never = (): never => {
  throw new Error("no such broken store");
};

/** `target` aborting `controller` at its `at`-th reset, and counting the resets after the abort. */
function abortingAt(at: number): {
  readonly target: ContractTarget<ExplorerStores>;
  readonly signal: AbortSignal;
  readonly afterAbort: () => number;
} {
  const { target } = counted(reusedEpoch());
  const controller = new AbortController();
  let resets = 0;
  let afterAbort = 0;
  return {
    target: {
      ...target,
      reset: async () => {
        resets += 1;
        if (controller.signal.aborted) afterAbort += 1;
        await target.reset?.();
        if (resets === at) controller.abort();
      },
    },
    signal: controller.signal,
    afterAbort: () => afterAbort,
  };
}

const lease3 = worldOf(ExplorerWorldKind.Lease, 3, ClockSkew.none);
const WALKS = { runs: 20, depth: 20, seed: 533 };

describe("#618: a search aborted while it shrinks the violation it found", () => {
  it("exhaustive: no reset after the abort — the violation as found, not shrunk, and why", async () => {
    const whole = counted(reusedEpoch());
    const done = await exhaustive(world, whole.target, 6);
    const aborting = abortingAt(whole.resets() - 2);

    const report = await exhaustive(world, aborting.target, 6, { signal: aborting.signal });

    expect(done.violation?.unshrunk).toBeUndefined();
    expect(aborting.afterAbort()).toBe(0);
    expect(report.violation?.unshrunk).toBe("its case was aborted (timed out or cancelled)");
    expect(report.violation?.violation.invariant).toBe(done.violation?.violation.invariant);
    expect(report.violation?.steps.length).toBe(report.violation?.foundLength);
  });

  it("walks: no reset after the abort, the walk's violation kept", async () => {
    const whole = counted(reusedEpoch());
    await randomWalks(lease3, whole.target, WALKS);
    const aborting = abortingAt(whole.resets() - 2);

    const report = await randomWalks(lease3, aborting.target, WALKS, { signal: aborting.signal });

    expect(aborting.afterAbort()).toBe(0);
    expect(report.violation?.unshrunk).toBe("its case was aborted (timed out or cancelled)");
  });

  it("past its time limit while it shrinks: the violation as found, the reason printed — never a pass", async () => {
    const whole = counted(reusedEpoch());
    await exhaustive(world, whole.target, 6);
    const flipAt = whole.resets() - 2;
    const watched = counted(reusedEpoch());
    // the time limit passes inside the shrink: from its reset `flipAt` on, the deadline is behind
    const budget = {
      get deadline() {
        return watched.resets() >= flipAt ? 0 : Number.POSITIVE_INFINITY;
      },
    };

    const report = await exhaustive(world, watched.target, 6, budget);
    const found = report.violation ?? never();

    expect(watched.resets()).toBe(flipAt);
    expect(found.unshrunk).toBe("it reached its time limit");
    expect(scheduleText("a reclaim that keeps the epoch", found)).toMatch(
      /schedule as found \(\d+ steps, not shrunk: it reached its time limit\):\n {3}1\. /u,
    );
  });
});
