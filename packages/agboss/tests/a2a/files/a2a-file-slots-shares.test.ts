/**
 * #1366: the shares of `fileSlotsOf` never exceed the one above them (#1297): a tenant's share is capped at
 * the listener's total before the owner's default is taken from it, so one owner of a listener with 2 slots
 * and a tenant share given as 10 still holds 1 slot, not 2.
 */
import { describe, expect, it } from "vitest";
import {
  callerKeyOf,
  fileSlotsOf,
  tenantKeyOf,
  type FileCaller,
} from "../../../src/a2a/files/a2a-file-slots.js";

const caller: FileCaller = { tenant: tenantKeyOf("t"), owner: callerKeyOf("t", "o") };
const anotherOwner: FileCaller = { tenant: tenantKeyOf("t"), owner: callerKeyOf("t", "p") };

/** The fetches of `callers` held on `slots`: how many started at once; `finish` lets every held one end. */
async function held(slots: ReturnType<typeof fileSlotsOf>, callers: readonly FileCaller[]) {
  const release: (() => void)[] = [];
  const started: FileCaller[] = [];
  const runs = callers.map((who) =>
    slots
      .run(
        new AbortController().signal,
        () => {
          started.push(who);
          return new Promise<void>((resolve) => release.push(resolve));
        },
        () => new Error("busy"),
        who,
      )
      .catch(() => undefined),
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  const atOnce = started.length;
  const finish = async (): Promise<void> => {
    // a slot given back starts the next in line: release until every run has settled
    for (let round = 0; round < callers.length; round += 1) {
      for (const done of release.splice(0)) done();
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await Promise.all(runs);
  };
  return { atOnce, finish };
}

describe("#1366: a share never exceeds the one above it", () => {
  it("a tenant share of 10 on 2 slots is 2: its one owner's default share is 1, not a quarter of 10", async () => {
    const run = await held(fileSlotsOf(2, 10), [caller, caller, caller]);

    expect(run.atOnce).toBe(1);
    await run.finish();
  });

  it("a given owner share above the tenant's is cut to it: owner 5 in a tenant of 2 runs 2", async () => {
    const run = await held(fileSlotsOf(16, 2, 5), [caller, caller, caller, caller]);

    expect(run.atOnce).toBe(2);
    await run.finish();
  });

  it("two owners of one tenant hold the tenant's share between them, whatever their own shares", async () => {
    const run = await held(fileSlotsOf(16, 2, 2), [caller, caller, anotherOwner, anotherOwner]);

    expect(run.atOnce).toBe(2);
    await run.finish();
  });
});
