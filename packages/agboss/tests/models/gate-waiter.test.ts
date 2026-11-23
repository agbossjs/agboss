/**
 * #1366: a call waiting in a provider's queue — it joins the queue, and when its signal aborts it leaves it at once
 * (so the room is never offered to it), is rejected with the signal's reason, and the gate is told; a signal that
 * was aborted before it asked never joins.
 */
import { describe, expect, it } from "vitest";
import { waitInQueue, type Waiter } from "../../src/models/calls/gate-waiter.js";

function queueOf() {
  const log: string[] = [];
  const waiters: Waiter[] = [];
  const queue = {
    add: (waiter: Waiter) => {
      log.push("add");
      waiters.push(waiter);
    },
    remove: (waiter: Waiter) => {
      log.push(waiters.includes(waiter) ? "remove" : "remove-unknown");
    },
  };
  return { queue: queue as never, log, waiters };
}

describe("#1366: waiting in the provider's queue", () => {
  it("an abort takes the call out of the queue, rejects it with the reason and tells the gate", async () => {
    const { queue, log, waiters } = queueOf();
    const cancel = new AbortController();
    const told: string[] = [];
    const waiting = waitInQueue(queue, { tenantId: "t", weight: 1, signal: cancel.signal }, () => {
      told.push("changed");
    }).catch((error: unknown) => error);

    cancel.abort(new Error("the caller left"));

    expect(await waiting).toMatchObject({ message: "the caller left" });
    expect(log).toEqual(["add", "remove"]);
    expect(told).toEqual(["changed", "changed"]);
    expect(waiters[0]?.isSettled()).toBe(true);
  });

  it("a call admitted is settled, and a later abort changes nothing", async () => {
    const { queue, log, waiters } = queueOf();
    const cancel = new AbortController();
    const waiting = waitInQueue(
      queue,
      { tenantId: "t", weight: 1, signal: cancel.signal },
      () => undefined,
    );

    const pass = { release: () => Promise.resolve() };
    waiters[0]?.admit(pass);
    cancel.abort(new Error("too late"));

    expect(await waiting).toBe(pass);
    expect(log).toEqual(["add"]);
  });

  it("a signal aborted before the call asked never joins the queue", async () => {
    const { queue, log } = queueOf();
    const cancel = new AbortController();
    cancel.abort(new Error("already gone"));

    const waiting = waitInQueue(
      queue,
      { tenantId: "t", weight: 1, signal: cancel.signal },
      () => undefined,
    );

    await expect(waiting).rejects.toThrow("already gone");
    expect(log).toEqual([]);
  });
});
