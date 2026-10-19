import { describe, expect, it } from "vitest";
import { VirtualClock } from "../../../src/testing/clock.js";
import { seconds } from "../../../src/units/index.js";
import { QueueTime, watchDeadline } from "../../../src/flow/runtime/launch/deadline.js";
import {
  AGING_STEP,
  TreeSlotRegistry,
  TreeSlots,
  type SlotClaim,
  type SlotHold,
} from "../../../src/flow/runtime/launch/launch-registry.js";

/**
 * #264 PR 2 — `TreeSlots`, the tree's priority semaphore (S27), on a virtual clock: at most
 * `maxConcurrentExecutions` executions at work (an execution's parallel steps share its slot), the
 * queue order (a parent closing a branch, then the deepest, aged every 10 s), a capped subtree, a
 * waiter that leaves when its signal aborts; and the quorum deadline's `QueueTime` (AC9).
 */

const claim = (executionId: string, depth = 1, closesBranch = false): SlotClaim => ({
  executionId,
  depth,
  closesBranch,
  subtrees: [],
});

const never = new AbortController().signal;

/** Takes a slot and records the order the slots were granted in. */
function taker(slots: TreeSlots, granted: string[]) {
  return async (wanted: SlotClaim, signal: AbortSignal = never): Promise<SlotHold | undefined> => {
    const hold = await slots.take(wanted, signal);
    if (hold !== undefined) granted.push(wanted.executionId);
    return hold;
  };
}

/** Lets the granted waiters' continuations run. */
const flush = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

describe("AC8: the cap — at most maxConcurrentExecutions executions at work", () => {
  it("a third execution waits until one of two frees its slot; no error", async () => {
    const granted: string[] = [];
    const slots = new TreeSlots(2, new VirtualClock());
    const take = taker(slots, granted);

    const first = await take(claim("a"));
    await take(claim("b"));
    const third = take(claim("c"));
    await flush();
    const whileFull = [...granted];
    first?.release();
    await third;

    expect(whileFull).toEqual(["a", "b"]);
    expect(granted).toEqual(["a", "b", "c"]);
  });

  it("an execution's parallel steps share its one slot, held until its last step ends", async () => {
    const granted: string[] = [];
    const slots = new TreeSlots(1, new VirtualClock());
    const take = taker(slots, granted);

    const one = await take(claim("a"));
    const two = await take(claim("a"));
    one?.release();
    const other = take(claim("b"));
    await flush();
    const whileWorking = [...granted];
    two?.release();
    await other;

    expect(whileWorking).toEqual(["a", "a"]);
    expect(granted).toEqual(["a", "a", "b"]);
  });

  it("a slot released twice frees it once", async () => {
    const granted: string[] = [];
    const slots = new TreeSlots(1, new VirtualClock());
    const take = taker(slots, granted);
    const hold = await take(claim("a"));
    const another = await take(claim("a"));

    hold?.release();
    hold?.release();
    const other = take(claim("b"));
    await flush();
    const afterTwice = [...granted];
    another?.release();
    await other;

    expect(afterTwice).toEqual(["a", "a"]);
    expect(granted).toEqual(["a", "a", "b"]);
  });

  it("a waiter whose signal aborts leaves the queue without a slot", async () => {
    const granted: string[] = [];
    const slots = new TreeSlots(1, new VirtualClock());
    const take = taker(slots, granted);
    const stop = new AbortController();
    const hold = await take(claim("a"));

    const waiting = take(claim("b"), stop.signal);
    stop.abort();
    const left = await waiting;
    hold?.release();
    await take(claim("c"));

    // b left: the slot a freed went straight to c
    expect(left).toBeUndefined();
    expect(granted).toEqual(["a", "c"]);
    await expect(take(claim("d"), stop.signal)).resolves.toBeUndefined();
  });

  it("a capped subtree holds its own executions below the tree's cap", async () => {
    const granted: string[] = [];
    const slots = new TreeSlots(4, new VirtualClock());
    const take = taker(slots, granted);
    const group = [{ executionId: "group", maxConcurrentExecutions: 1 }];
    const inGroup = (id: string): SlotClaim => ({ ...claim(id, 3), subtrees: group });

    const first = await take(inGroup("task-1"));
    const second = take(inGroup("task-2"));
    await take(claim("other", 2));
    await flush();

    expect(granted).toEqual(["task-1", "other"]);
    first?.release();
    await second;
    expect(granted).toEqual(["task-1", "other", "task-2"]);
  });
});

describe("AC9: the queue order — a closing parent, then the deepest, with aging", () => {
  it("a parent whose children all finished goes before deeper waiters", async () => {
    const granted: string[] = [];
    const holds = new Map<string, SlotHold>();
    const slots = new TreeSlots(1, new VirtualClock());
    const take = async (wanted: SlotClaim): Promise<void> => {
      const hold = await slots.take(wanted, never);
      if (hold !== undefined) holds.set(wanted.executionId, hold);
      granted.push(wanted.executionId);
    };
    await take(claim("busy"));
    const waiting = Promise.all([
      take(claim("shallow", 2)),
      take(claim("deep", 4)),
      take(claim("parent", 1, true)),
      take(claim("deeper", 3)),
    ]);

    for (const id of ["busy", "parent", "deep", "deeper", "shallow"]) {
      holds.get(id)?.release();
      await flush();
    }
    await waiting;

    expect(granted).toEqual(["busy", "parent", "deep", "deeper", "shallow"]);
  });

  it("every 10 s of waiting counts as one level deeper (the Clock's time)", async () => {
    const granted: string[] = [];
    const holds = new Map<string, SlotHold>();
    const clock = new VirtualClock();
    const slots = new TreeSlots(1, clock);
    const take = async (wanted: SlotClaim): Promise<void> => {
      const hold = await slots.take(wanted, never);
      if (hold !== undefined) holds.set(wanted.executionId, hold);
      granted.push(wanted.executionId);
    };
    await take(claim("busy"));
    const old = take(claim("old", 1));
    await clock.advance(seconds(25));
    const later = Promise.all([take(claim("deep", 3)), take(claim("shallow", 2))]);

    for (const id of ["busy", "old", "deep", "shallow"]) {
      holds.get(id)?.release();
      await flush();
    }
    await Promise.all([old, later]);

    // "old" waited 25 s: depth 1 + 2 levels = 3 — level with "deep", and it came first
    expect(AGING_STEP).toBe(seconds(10));
    expect(granted).toEqual(["busy", "old", "deep", "shallow"]);
  });
});

describe("the trees of a pass by rootExecutionId", () => {
  it("one TreeSlots per root, made with the root's cap on its first claim", () => {
    const registry = new TreeSlotRegistry();
    const clock = new VirtualClock();

    const first = registry.slotsOf("root-1", 3, clock);

    expect(registry.slotsOf("root-1", 7, clock)).toBe(first);
    expect(first.maxConcurrentExecutions).toBe(3);
    expect(registry.slotsOf("root-2", 7, clock)).not.toBe(first);
  });
});

describe("AC9: a quorum's deadline excludes the time in the tree's queue", () => {
  it("the deadline moves by the time its branches waited, and never passes while they wait", async () => {
    const clock = new VirtualClock();
    const queued = new QueueTime(clock);
    const stop = new AbortController();
    const expired: number[] = [];
    const deadlineAt = clock.now().getTime() + seconds(30);
    watchDeadline(clock, deadlineAt, stop.signal, queued, () => {
      expired.push(clock.now().getTime() - (deadlineAt - seconds(30)));
    });

    queued.enter();
    queued.enter();
    await clock.advance(seconds(40));
    queued.leave();
    await clock.advance(seconds(5));
    expect(expired).toEqual([]);
    queued.leave();
    await clock.advance(seconds(29));
    expect(expired).toEqual([]);
    await clock.advance(seconds(1));

    // 30 s of deadline + 45 s in the queue
    expect(expired).toEqual([seconds(75)]);
    expect(queued.excluded()).toBe(seconds(45));
  });

  it("without time in the queue the deadline is the ticket's", async () => {
    const clock = new VirtualClock();
    const queued = new QueueTime(clock);
    const expired: boolean[] = [];
    watchDeadline(clock, clock.now().getTime() + seconds(30), never, queued, () => {
      expired.push(true);
    });

    await clock.advance(seconds(30));

    expect(expired).toEqual([true]);
  });

  it("a stopped watch never expires, also while its branches wait", async () => {
    const clock = new VirtualClock();
    const queued = new QueueTime(clock);
    const stop = new AbortController();
    const expired: boolean[] = [];
    watchDeadline(clock, clock.now().getTime() + seconds(30), stop.signal, queued, () => {
      expired.push(true);
    });

    queued.enter();
    await clock.advance(seconds(5));
    stop.abort();
    queued.leave();
    await clock.advance(seconds(60));

    expect(expired).toEqual([]);
    await expect(queued.whenResumed(stop.signal)).resolves.toBeUndefined();
  });
});
