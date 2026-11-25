/**
 * #1356 (pauses shards) — the built-in pause stores, in memory and on SQLite, on their own: what a mark of the
 * channel's send, a reassignment and a `Taken` answer return and change, which pauses a tree's read and a
 * replacement's step key take, the order and size of the scans, and the limit every scan refuses when it is none.
 */
import { describe, expect, it } from "vitest";
import { InMemoryPausedExecutionRepository } from "../../src/infrastructure/in-memory-paused-execution.repository.js";
import type { PausedExecutionRepository } from "../../src/infrastructure/paused-execution.repository.js";
import {
  NO_RECIPIENTS,
  PauseStatus,
  type PauseRecord,
} from "../../src/infrastructure/pause-record.js";
import { SqlitePausedExecutionRepository } from "../../src/infrastructure/sqlite/sqlite-paused-execution.repository.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { pauseOf } from "../../src/testing/contracts/paused-execution-data.js";
import { seconds } from "../../src/units/index.js";
import { connectionTo, temporarySqlitePath } from "./contracts/store-kinds.js";

const kinds: readonly (readonly [string, () => PausedExecutionRepository])[] = [
  ["in memory", () => new InMemoryPausedExecutionRepository()],
  [
    "SQLite",
    () =>
      new SqlitePausedExecutionRepository(
        connectionTo(temporarySqlitePath()),
        new VirtualClock(new Date(0)),
      ),
  ],
];

const T = (hour: number): string => `2026-11-20T${String(hour).padStart(2, "0")}:00:00.000Z`;
const at = (hour: number): Date => new Date(T(hour));
const answer = { decision: { approved: true }, actor: undefined };

/** A pause of `tree` in `tenant`, with the deadline and reminder given. */
const pause = (
  id: string,
  fields: Partial<PauseRecord> = {},
  tree = "root-1",
  tenantId = "default",
): PauseRecord => ({
  ...pauseOf(id, `${tree}:s:${id}`),
  tenantId,
  rootExecutionId: tree,
  ...fields,
});

describe.each(kinds)("#1356: the pause store %s", (_kind, make) => {
  it("a send that the channel made is marked for a pending pause only: a resolved one, and one that is not there, are not", async () => {
    const store = make();
    await store.findOrCreateByStepKey(pause("p-1"));
    await store.findOrCreateByStepKey(pause("p-2"));
    await store.resolveByTenantIdAndPauseId("default", "p-2", answer, at(10), NO_RECIPIENTS);

    expect(await store.markSentByTenantIdAndPauseId("default", "p-1", NO_RECIPIENTS)).toBe(true);
    expect(await store.markSentByTenantIdAndPauseId("default", "p-2", NO_RECIPIENTS)).toBe(false);
    expect(await store.markSentByTenantIdAndPauseId("default", "p-none", NO_RECIPIENTS)).toBe(
      false,
    );
    expect(await store.markSentByTenantIdAndPauseId("other", "p-1", NO_RECIPIENTS)).toBe(false);
  });

  it("an answer taken turns a resolved pause to taken; a pending pause, and one that is not there, stay as they are", async () => {
    const store = make();
    await store.findOrCreateByStepKey(pause("p-1"));
    await store.findOrCreateByStepKey(pause("p-2"));
    await store.resolveByTenantIdAndPauseId("default", "p-2", answer, at(10), NO_RECIPIENTS);

    await store.markTakenByTenantIdAndPauseId("default", "p-1");
    await store.markTakenByTenantIdAndPauseId("default", "p-2");
    await store.markTakenByTenantIdAndPauseId("default", "p-none");

    expect((await store.findByTenantIdAndPauseId("default", "p-1"))?.status).toBe(
      PauseStatus.Pending,
    );
    expect((await store.findByTenantIdAndPauseId("default", "p-2"))?.status).toBe(
      PauseStatus.Taken,
    );
    expect(await store.findByTenantIdAndPauseId("default", "p-none")).toBeUndefined();
  });

  it("a tree's pauses are the tenant's own of that root, in the order they were made", async () => {
    const store = make();
    await store.findOrCreateByStepKey(pause("p-1", {}, "root-1"));
    await store.findOrCreateByStepKey(pause("p-2", {}, "root-2"));
    await store.findOrCreateByStepKey(pause("p-3", {}, "root-1"));
    await store.findOrCreateByStepKey(pause("p-4", {}, "root-1", "other"));

    const ids = async (tenant: string, root: string) =>
      (await store.findAllByTenantIdAndRootExecutionId(tenant, root)).map((one) => one.pauseId);

    expect(await ids("default", "root-1")).toEqual(["p-1", "p-3"]);
    expect(await ids("default", "root-2")).toEqual(["p-2"]);
    expect(await ids("other", "root-1")).toEqual(["p-4"]);
    expect(await ids("other", "root-2")).toEqual([]);
  });

  it("a reassignment of a pause that is not there makes nothing; of one that is, it returns its replacement", async () => {
    const store = make();
    await store.findOrCreateByStepKey(pause("p-1"));

    const none = await store.reassignByTenantIdAndPauseId(
      "default",
      "p-none",
      { pauseId: "p-x", assignees: ["anna"] },
      at(10),
      NO_RECIPIENTS,
    );
    const made = await store.reassignByTenantIdAndPauseId(
      "default",
      "p-1",
      { pauseId: "p-2", assignees: ["anna"] },
      at(10),
      NO_RECIPIENTS,
    );

    expect(none).toBeUndefined();
    expect(made).toMatchObject({ pauseId: "p-2", assignees: ["anna"], reassignedFrom: "p-1" });
    expect(await store.findByTenantIdAndPauseId("default", "p-x")).toBeUndefined();
    // a pause that is not there makes no replacement, though the id it names is another pause's
    expect(
      await store.reassignByTenantIdAndPauseId(
        "default",
        "p-none",
        { pauseId: "p-1", assignees: ["anna"] },
        at(10),
        NO_RECIPIENTS,
      ),
    ).toBeUndefined();
  });

  it("a replacement is numbered among the step keys of its own tree only, never another tree's or tenant's", async () => {
    const store = make();
    await store.findOrCreateByStepKey(pause("p-1", { stepKey: "k" }));
    await store.findOrCreateByStepKey(pause("p-2", { stepKey: "k~r1" }, "root-2"));
    await store.findOrCreateByStepKey(pause("p-3", { stepKey: "k~r1" }, "root-1", "other"));

    const made = await store.reassignByTenantIdAndPauseId(
      "default",
      "p-1",
      { pauseId: "p-4", assignees: ["anna"] },
      at(10),
      NO_RECIPIENTS,
    );
    const again = await store.reassignByTenantIdAndPauseId(
      "default",
      "p-4",
      { pauseId: "p-5", assignees: ["ben"] },
      at(11),
      NO_RECIPIENTS,
    );

    expect(made?.stepKey).toBe("k~r1");
    expect(again?.stepKey).toBe("k~r2");
  });

  it("the due scans list the pending pauses whose time is over, by time, tenant and id, at most `limit`, and go on after a keyset", async () => {
    const store = make();
    await store.findOrCreateByStepKey(pause("p-b", { expiresAt: T(9), remindAt: T(7) }));
    await store.findOrCreateByStepKey(pause("p-a", { expiresAt: T(9), remindAt: T(8) }));
    await store.findOrCreateByStepKey(pause("p-c", { expiresAt: T(8), remindAt: T(9) }));
    await store.findOrCreateByStepKey(pause("p-d", { expiresAt: T(12), remindAt: T(12) }));
    await store.findOrCreateByStepKey(pause("p-e"));
    const ids = (pauses: readonly PauseRecord[]) => pauses.map((one) => one.pauseId);

    expect(ids(await store.findPendingByExpiresAtBefore(at(10), 10))).toEqual([
      "p-c",
      "p-a",
      "p-b",
    ]);
    expect(ids(await store.findPendingByExpiresAtBefore(at(10), 2))).toEqual(["p-c", "p-a"]);
    expect(ids(await store.findPendingByExpiresAtBefore(at(9), 10))).toEqual(["p-c", "p-a", "p-b"]);
    expect(ids(await store.findPendingByExpiresAtBefore(at(8), 10))).toEqual(["p-c"]);
    expect(ids(await store.findPendingByRemindAtBefore(at(10), 10))).toEqual(["p-b", "p-a", "p-c"]);
    expect(ids(await store.findPendingByRemindAtBefore(at(10), 2))).toEqual(["p-b", "p-a"]);
    expect(
      ids(
        await store.findPendingByExpiresAtBefore(at(10), 10, {
          at: T(9),
          tenantId: "default",
          pauseId: "p-a",
        }),
      ),
    ).toEqual(["p-b"]);
    expect(
      ids(
        await store.findPendingByRemindAtBefore(at(10), 10, {
          at: T(7),
          tenantId: "default",
          pauseId: "p-b",
        }),
      ),
    ).toEqual(["p-a", "p-c"]);
  });

  it("every scan refuses a limit that is not a whole number from 1 to 1000", async () => {
    const store = make();
    const scans: readonly ((limit: number) => Promise<unknown>)[] = [
      (limit) => store.findPendingByExpiresAtBefore(at(10), limit),
      (limit) => store.findPendingByRemindAtBefore(at(10), limit),
      (limit) => store.findPendingUnsentReassignedBefore(at(10), limit),
      (limit) => store.findOpenAfter(undefined, limit),
      (limit) => store.findPageByTenantId("default", { statuses: [PauseStatus.Pending] }, limit),
      (limit) => store.findClosedByResolvedAtBefore(at(10), limit),
      (limit) => store.claimNoticesDue(at(10), limit, seconds(1), []),
      (limit) => store.setAsideStaleNoticesBefore(at(10), at(10), "stale", limit),
    ];

    for (const scan of scans)
      for (const limit of [0, 1001, 1.5, -1]) await expect(scan(limit)).rejects.toThrow(RangeError);
    for (const scan of scans) await expect(scan(1)).resolves.toBeDefined();
  });

  it("the scans of a tenant's pages refuse a filter with no status", async () => {
    const store = make();

    await expect(store.findPageByTenantId("default", { statuses: [] }, 10)).rejects.toThrow(
      "a pause filter names at least one status",
    );
  });
});
