/**
 * #1366: the in-process slots — a semaphore gives a slot back (a released one is free again, an aborted waiter
 * leaves and takes none), a launch's entry is removed with its quorum stopped, a tree's cap and its capped
 * subtrees count executions (a released one frees exactly one place), an aborted take holds nothing, and a tree
 * that could launch on any instance still gets in-process slots when the application keeps no shared store.
 */
import { describe, expect, it } from "vitest";
import {
  LaunchRegistry,
  Semaphore,
  TreeSlotRegistry,
  TreeSlots,
  type SlotClaim,
} from "../../../src/flow/runtime/launch/launch-registry.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { RemoteCappedWorkflow } from "./fixtures/remote-limits.workflow.js";

const open = new AbortController().signal;
const aborted = (): AbortSignal => AbortSignal.abort();

/** Lets promises that resolved already run their continuations. */
const settled = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const claimOf = (
  executionId: string,
  subtrees: SlotClaim["subtrees"] = [],
  depth = 2,
): SlotClaim => ({ executionId, depth, closesBranch: false, subtrees });

/** The state of a take that may still wait. */
const watch = (taken: Promise<unknown>) => {
  const state: { hold?: unknown; done: boolean } = { done: false };
  void taken.then((hold) => {
    state.hold = hold;
    state.done = true;
  });
  return state;
};

describe("#1366: Semaphore", () => {
  it("a released slot is free again", async () => {
    const slots = new Semaphore(1);
    await slots.acquire(open);
    slots.release();

    const again = watch(slots.acquire(open));
    await settled();

    expect(again.done).toBe(true);
    const next = watch(slots.acquire(open));
    await settled();
    expect(next.done).toBe(false);
  });

  it("an aborted signal gets false and takes no slot", async () => {
    const slots = new Semaphore(1);

    expect(await slots.acquire(aborted())).toBe(false);

    expect(await slots.acquire(open)).toBe(true);
  });

  it("a waiter whose signal aborts gets false and leaves; the next release is not lost on it", async () => {
    const slots = new Semaphore(1);
    await slots.acquire(open);
    const cancel = new AbortController();
    const left = slots.acquire(cancel.signal);

    cancel.abort();
    expect(await left).toBe(false);
    slots.release();
    const next = watch(slots.acquire(open));
    await settled();

    expect(next.done).toBe(true);
  });

  it("a waiter that was granted ignores its signal aborting later; the waiters behind it keep their place", async () => {
    const slots = new Semaphore(1);
    await slots.acquire(open);
    const granted = new AbortController();
    const first = watch(slots.acquire(granted.signal));
    const second = watch(slots.acquire(open));
    slots.release();
    await settled();

    granted.abort();
    slots.release();
    await settled();

    expect(first.done).toBe(true);
    expect(second.done).toBe(true);
  });

  it("a release hands its slot to the first waiter", async () => {
    const slots = new Semaphore(1);
    await slots.acquire(open);
    const first = watch(slots.acquire(open));
    const second = watch(slots.acquire(open));
    await settled();

    slots.release();
    await settled();

    expect(first.done).toBe(true);
    expect(second.done).toBe(false);
  });
});

describe("#1366: LaunchRegistry", () => {
  it("a launch's entry has no quorum key without a quorum", () => {
    const entry = new LaunchRegistry().liveOf("l1", 2);

    expect(Object.keys(entry).sort()).toEqual(["controller", "errors", "slots", "spent"]);
  });

  it("remove forgets the entry and stops its quorum", () => {
    const registry = new LaunchRegistry();
    const stop = new AbortController();
    const quorum = { stop } as never;
    registry.liveOf("l1", 2, () => quorum);
    expect(registry.find("l1")).toBeDefined();

    registry.remove("l1");

    expect(registry.find("l1")).toBeUndefined();
    expect(stop.signal.aborted).toBe(true);
    registry.remove("l1");
  });
});

describe("#1366: a tree's in-process slots", () => {
  const slotsOf = (cap: number) => new TreeSlots(cap, new VirtualClock());

  it("a take with an aborted signal holds nothing", async () => {
    const slots = slotsOf(1);

    expect(await slots.take(claimOf("a"), aborted())).toBeUndefined();

    const b = watch(slots.take(claimOf("b"), open));
    await settled();
    expect(b.done).toBe(true);
    expect(b.hold).toBeDefined();
  });

  it("a released execution frees one place of its subtree, not all", async () => {
    const slots = slotsOf(10);
    const subtree = [{ executionId: "s", maxConcurrentExecutions: 2 }];
    const a = await slots.take(claimOf("a", subtree), open);
    await slots.take(claimOf("b", subtree), open);
    a?.release();

    const c = watch(slots.take(claimOf("c", subtree), open));
    const d = watch(slots.take(claimOf("d", subtree), open));
    await settled();

    expect(c.done).toBe(true);
    expect(d.done).toBe(false);
  });

  it("a registry without a shared store gives a tree that could launch anywhere in-process slots", async () => {
    const registry = new TreeSlotRegistry();
    const root = {
      executionId: "root-1",
      workflow: { type: RemoteCappedWorkflow },
      tenant: { tenantId: "acme" },
    };

    const slots = registry.slotsOf(root, 1, new VirtualClock());
    const hold = await slots.take(claimOf("a"), open);

    expect(slots).toBeInstanceOf(TreeSlots);
    expect(hold).toBeDefined();
    expect(registry.slotsOf(root, 5, new VirtualClock())).toBe(slots);
  });
});
