/** #1312: the application's default fetch slots: one set per file store, made once, the default limits. */
import { describe, expect, it } from "vitest";
import { appFileSlotsOf } from "../../../../src/a2a/files/a2a-file-pool.js";
import type { FileCaller, FileFetchSlots } from "../../../../src/a2a/files/a2a-file-slots.js";

/** How many of `callers` run at once on `slots` (each held until the probe ends); the rest wait. */
async function runningOf(slots: FileFetchSlots, callers: readonly FileCaller[]): Promise<number> {
  const ended = new AbortController();
  let running = 0;
  const releases: (() => void)[] = [];
  const runs = callers.map((caller) =>
    slots
      .run(
        ended.signal,
        () =>
          new Promise<void>((resolve) => {
            running += 1;
            releases.push(resolve);
          }),
        () => new Error("busy"),
        caller,
      )
      .then(
        () => undefined,
        () => undefined, // refused, or left the queue with the probe
      ),
  );
  await new Promise((resolve) => setImmediate(resolve));
  const count = running;
  ended.abort(new Error("probe over"));
  // the waiting leave with the signal's reason, the running ones are let go
  for (const release of releases) release();
  await Promise.all(runs);
  return count;
}

const many = (count: number, of: (at: number) => FileCaller): FileCaller[] =>
  Array.from({ length: count }, (_, at) => of(at));

describe("the application's fetch slots", () => {
  it("the same store has the same slots, another store its own", () => {
    const store = {};
    expect(appFileSlotsOf(store)).toBe(appFileSlotsOf(store));
    expect(appFileSlotsOf({})).not.toBe(appFileSlotsOf(store));
  });

  it("they are the default slots: 16 in all, a tenant's quarter of them, an owner's quarter of that", async () => {
    const slots = (): FileFetchSlots => appFileSlotsOf({});
    expect(
      await runningOf(
        slots(),
        many(20, (at) => ({ tenant: `t${String(at)}`, owner: `o${String(at)}` })),
      ),
    ).toBe(16);
    expect(
      await runningOf(
        slots(),
        many(20, (at) => ({ tenant: "t", owner: `o${String(at)}` })),
      ),
    ).toBe(4);
    expect(
      await runningOf(
        slots(),
        many(20, () => ({ tenant: "t", owner: "o" })),
      ),
    ).toBe(1);
  });
});
