import { describe, expect, it } from "vitest";
import { StepSlots } from "../../src/app/step-slots.js";
import {
  AGING_STEP,
  type QueueClaim,
  type SlotHold,
} from "../../src/flow/runtime/launch/slot-queue.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { seconds } from "../../src/units/index.js";

/**
 * #332 AC2 — `StepSlots`, the instance's priority semaphore, on a virtual clock: at most
 * `maxConcurrentSteps` steps (two steps of one execution are two), the queue order — a step closing
 * a branch, then the deepest, aged every `AGING_STEP` —, and a waiter that leaves when its signal
 * aborts; what readiness and the recovery sweep read of it.
 */

const claim = (depth = 1, closesBranch = false): QueueClaim => ({ depth, closesBranch });

const never = new AbortController().signal;

/** Takes a slot named `name` and records the order the slots were granted in. */
function taker(slots: StepSlots, granted: string[]) {
  return async (
    name: string,
    wanted: QueueClaim = claim(),
    signal: AbortSignal = never,
  ): Promise<SlotHold | undefined> => {
    const hold = await slots.take(wanted, signal);
    if (hold !== undefined) granted.push(name);
    return hold;
  };
}

/** Lets the granted waiters' continuations run. */
const flush = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

describe("AC1: the cap — at most maxConcurrentSteps steps at work", () => {
  it("a third step waits until one of two frees its slot; the counts follow", async () => {
    const granted: string[] = [];
    const slots = new StepSlots(2, new VirtualClock());
    const take = taker(slots, granted);

    const first = await take("a");
    await take("b");
    const third = take("c");
    await flush();
    const whileFull = {
      granted: [...granted],
      free: slots.freeSlots(),
      waiting: slots.waitingSteps(),
    };
    first?.release();
    first?.release(); // a second release frees nothing more
    await third;

    expect(whileFull).toEqual({ granted: ["a", "b"], free: 0, waiting: 1 });
    expect(granted).toEqual(["a", "b", "c"]);
    expect([slots.busySlots(), slots.freeSlots(), slots.waitingSteps()]).toEqual([2, 0, 0]);
  });
});

describe("AC2: the queue order", () => {
  it("a step closing a branch goes first, then the deepest, then the first come", async () => {
    const granted: string[] = [];
    const slots = new StepSlots(1, new VirtualClock());
    const take = taker(slots, granted);
    const holder = await take("holder");

    // each one works at once and frees its slot for the next
    const takeAndRelease = async (name: string, wanted: QueueClaim): Promise<void> => {
      (await take(name, wanted))?.release();
    };
    const waiting = [
      takeAndRelease("root", claim(1)),
      takeAndRelease("deep", claim(3)),
      takeAndRelease("closing", claim(1, true)),
      takeAndRelease("deep-later", claim(3)),
    ];
    await flush();
    holder?.release();
    await Promise.all(waiting);

    expect(granted).toEqual(["holder", "closing", "deep", "deep-later", "root"]);
  });

  it("aging: every AGING_STEP of waiting counts as one level deeper", async () => {
    const clock = new VirtualClock();
    const granted: string[] = [];
    const slots = new StepSlots(1, clock);
    const take = taker(slots, granted);
    const holder = await take("holder");

    const old = take("old-root", claim(1));
    await clock.advance(seconds(20));
    const deeper = take("new-depth-2", claim(2));
    await flush();
    holder?.release();
    (await old)?.release();
    await deeper;

    // waited 20 s: level 1 + 2 = 3, above the newcomer's 2
    expect(AGING_STEP).toBe(seconds(10));
    expect(granted).toEqual(["holder", "old-root", "new-depth-2"]);
  });

  it("a waiter whose signal aborts leaves the queue: the next one takes the slot", async () => {
    const granted: string[] = [];
    const slots = new StepSlots(1, new VirtualClock());
    const take = taker(slots, granted);
    const holder = await take("holder");
    const cancel = new AbortController();

    const leaving = take("cancelled", claim(5), cancel.signal);
    const staying = take("staying");
    await flush();
    cancel.abort();
    const left = await leaving;
    const waitingAfterLeave = slots.waitingSteps();
    holder?.release();
    await staying;

    expect(left).toBeUndefined();
    expect(waitingAfterLeave).toBe(1);
    expect(granted).toEqual(["holder", "staying"]);
  });

  it("an aborted signal takes no slot at all", async () => {
    const slots = new StepSlots(1, new VirtualClock());
    const aborted = new AbortController();
    aborted.abort();

    const hold = await slots.take(claim(), aborted.signal);

    expect(hold).toBeUndefined();
    expect(slots.freeSlots()).toBe(1);
  });
});
