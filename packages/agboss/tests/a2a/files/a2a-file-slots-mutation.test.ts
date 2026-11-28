/**
 * #1356 (mutation shard `a2a-server`): a caller that names no owner holds no owner's share — it runs and
 * waits under its tenant's alone, and counts as no owner.
 */
import { describe, expect, it } from "vitest";
import { FileFetchSlots } from "../../../src/a2a/files/a2a-file-slots.js";
import { settle } from "../server/support/unit-parts.js";

const NONE = { running: 0, queued: 0 };
const ROOM = { running: 5, queued: 5 };
const full = () => new Error("full");

/** A fetch that holds its slot until `release`. */
function holding(slots: FileFetchSlots, caller: { tenant: string; owner?: string }) {
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const state = { started: false, settled: false, error: undefined as unknown };
  const done = slots
    .run(
      new AbortController().signal,
      async () => {
        state.started = true;
        await held;
      },
      full,
      caller,
    )
    .catch((error: unknown) => {
      state.error = error;
    })
    .finally(() => {
      state.settled = true;
    });
  return { state, release, done };
}

describe("a caller with no owner and an owners' share of none", () => {
  it("runs at once: only its tenant's share bounds it", async () => {
    const slots = new FileFetchSlots(2, 2, ROOM, NONE);

    const fetch = holding(slots, { tenant: "t1" });
    await settle();

    expect(fetch.state.started).toBe(true);
    expect(slots.callers).toBe(0);
    expect(slots.tenants).toBe(1);
    fetch.release();
    await fetch.done;
    expect(slots.tenants).toBe(0);
  });

  it("waits for a slot when the pool is full, never refused for want of a place of its owner's: it counts as no owner", async () => {
    const slots = new FileFetchSlots(1, 2, ROOM, NONE);
    const first = holding(slots, { tenant: "t1" });
    await settle();

    const second = holding(slots, { tenant: "t2" });
    await settle();

    expect(second.state.started).toBe(false);
    expect(second.state.error).toBeUndefined();
    expect(slots.callers).toBe(0);
    expect(slots.tenants).toBe(2);
    first.release();
    await settle();
    expect(second.state.started).toBe(true);
    second.release();
    await Promise.all([first.done, second.done]);
    expect(slots.tenants).toBe(0);
  });

  it("a caller with an owner is bound by it: refused at once when the owner has no place", async () => {
    const slots = new FileFetchSlots(1, 2, ROOM, NONE);
    const first = holding(slots, { tenant: "t1" });
    await settle();

    const owned = holding(slots, { tenant: "t2", owner: "dana" });
    await owned.done;

    expect(owned.state.started).toBe(false);
    expect((owned.state.error as Error).message).toBe("full");
    first.release();
    await first.done;
  });
});
