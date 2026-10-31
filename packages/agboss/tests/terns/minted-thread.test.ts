/**
 * #550: a thread id the store mints (no `threadId` given) is never a thread the tenant already has.
 * Two tests on one SQLite file both start their `SequentialIdGenerator` at `thread-1`
 * (flow-patterns runs its files on one module graph per worker, so its `instances` environment is
 * one file per worker): `ON CONFLICT DO NOTHING` used to hand the second test the first one's
 * thread — of another workflow (`UnknownThreadError` at the pass's `openThread`), or of another
 * owner of the same workflow (its history joined in silence).
 */
import { describe, expect, it } from "vitest";
import { createSqliteTernStore } from "../../src/terns/index.js";

/** Ids in order, as `SequentialIdGenerator` mints them. */
const sequential = () => {
  let next = 0;
  return {
    newThreadId: (): string => {
      next += 1;
      return `thread-${String(next)}`;
    },
  };
};

describe("#550: a minted thread id is a new thread", () => {
  it("an id another workflow's thread has is skipped: the next one is minted", async () => {
    const store = createSqliteTernStore(":memory:", () => new Date(), sequential());
    await store.createThread({
      workflow: "credit-workflow",
      tenantId: "default",
      threadId: "thread-1",
    });

    const minted = await store.createThread({
      workflow: "offsite-booking-workflow",
      tenantId: "default",
    });

    expect(minted).toBe("thread-2");
    expect(await store.hasThread("offsite-booking-workflow", "default", minted)).toBe(true);
    expect(await store.hasThread("credit-workflow", "default", "thread-1")).toBe(true);
  });

  it("an id another owner's thread of the same workflow has is skipped: its history stays its own", async () => {
    const store = createSqliteTernStore(":memory:", () => new Date(), sequential());
    await store.createThread({
      workflow: "desk-workflow",
      tenantId: "default",
      ownerId: "alice",
      threadId: "thread-1",
    });

    const minted = await store.createThread({
      workflow: "desk-workflow",
      tenantId: "default",
      ownerId: "bob",
    });

    expect(minted).toBe("thread-2");
    expect(await store.threadOwner("desk-workflow", "default", "thread-1")).toEqual({
      owner: "alice",
    });
    expect(await store.threadOwner("desk-workflow", "default", minted)).toEqual({ owner: "bob" });
  });

  it("another tenant's thread-1 is no collision: each tenant's key is its own", async () => {
    const store = createSqliteTernStore(":memory:", () => new Date(), sequential());
    await store.createThread({ workflow: "desk-workflow", tenantId: "acme", threadId: "thread-1" });

    expect(await store.createThread({ workflow: "desk-workflow", tenantId: "default" })).toBe(
      "thread-1",
    );
  });

  it("a caller's own id that exists is kept as it was — the first one keeps it (#262 Q4)", async () => {
    const store = createSqliteTernStore(":memory:", () => new Date(), sequential());
    await store.createThread({
      workflow: "desk-workflow",
      tenantId: "default",
      ownerId: "alice",
      threadId: "mine",
    });

    expect(
      await store.createThread({
        workflow: "desk-workflow",
        tenantId: "default",
        ownerId: "bob",
        threadId: "mine",
      }),
    ).toBe("mine");
    expect(await store.threadOwner("desk-workflow", "default", "mine")).toEqual({ owner: "alice" });
  });
});
