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
import { inMemoryTarget } from "../../../infrastructure/contracts/store-kinds.js";

/** The in-memory call target, counting the resets it is asked for (one per schedule). */
function counted(): {
  readonly target: ContractTarget<ExplorerStores>;
  readonly resets: () => number;
} {
  const inner = callTarget(inMemoryTarget(inMemoryOutboundCalls));
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
