/**
 * #1307 (G3, pauses shard) — the mailbox operations and the saved paused run refuse an Invalid Date
 * before they write anything, in memory and on SQLite alike: a `StoreError.UnreadableRecord` that says
 * an Invalid Date was given and nothing was written, never a `RangeError` and never a stuck mailbox.
 */
import { describe, expect, it } from "vitest";
import { StoreError } from "../../src/core/error-families/store-errors.js";
import { InMemoryPausedExecutionRepository } from "../../src/infrastructure/in-memory-paused-execution.repository.js";
import type { PausedExecutionRepository } from "../../src/infrastructure/paused-execution.repository.js";
import { SqlitePausedExecutionRepository } from "../../src/infrastructure/sqlite/sqlite-paused-execution.repository.js";
import { VirtualClock } from "../../src/testing/clock.js";
import {
  ALL_KEYS,
  APPROVED_BY_MANAGER,
  pauseOf,
  RECIPIENTS,
} from "../../src/testing/contracts/paused-execution-data.js";
import { seconds } from "../../src/units/index.js";
import { connectionTo, temporarySqlitePath } from "./contracts/store-kinds.js";
import { pausedRun } from "./sqlite/stored-rows.fixtures.js";

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
const BAD = (): Date => new Date(Number.NaN);
const at = (second: number): Date => new Date(second * 1000);

const refusalOf = async (call: () => Promise<unknown>): Promise<StoreError.UnreadableRecord> => {
  const error: unknown = await call().then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(StoreError.UnreadableRecord);
  return error as StoreError.UnreadableRecord;
};

describe.each(kinds)(
  "#1307: an Invalid Date given to the mailboxes of the pause store %s",
  (_kind, make) => {
    it("is refused by claim, ack, renew, retry and the stale set-aside, and nothing changes", async () => {
      const store = make();
      await store.findOrCreateByStepKey(pauseOf("p-a", "run-1:p-a:1:call-1"));
      await store.markSentByTenantIdAndPauseId("default", "p-a", RECIPIENTS);
      await store.resolveByTenantIdAndPauseId(
        "default",
        "p-a",
        APPROVED_BY_MANAGER,
        at(10),
        RECIPIENTS,
      );
      const [claim] = await store.claimNoticesDue(at(10), 1, seconds(30), ALL_KEYS);
      if (claim === undefined) throw new Error("a mailbox is due");
      const counts = await store.countNotices();

      const refusals = [
        await refusalOf(() => store.claimNoticesDue(BAD(), 10, seconds(30), ALL_KEYS)),
        await refusalOf(() => store.ackNotice(claim, BAD())),
        await refusalOf(() => store.renewNotice(claim, BAD(), seconds(30))),
        await refusalOf(() => store.retryNotice(claim, BAD(), "receiver.timeout")),
        await refusalOf(() => store.setAsideStaleNoticesBefore(BAD(), at(10), "stale", 10)),
        await refusalOf(() => store.setAsideStaleNoticesBefore(at(10), BAD(), "stale", 10)),
      ];

      for (const error of refusals) {
        expect(error.message).toContain("an Invalid Date was given for");
        expect(error.message).toContain("nothing was written");
      }
      expect(await store.countNotices()).toEqual(counts);
      // the claim is still its own, and the mailbox is not stuck
      expect(await store.retryNotice(claim, at(20), "receiver.timeout")).toBe(true);
      expect(await store.claimNoticesDue(at(20), 10, seconds(30), ALL_KEYS)).not.toHaveLength(0);
    });

    it("a paused run with an Invalid Date in a pending pause's expiresAt is refused when saved, and not kept", async () => {
      const store = make();
      const waiting = { ...pausedRun, tenantId: "acme", threadId: "thread-1", runId: "run-1" };
      const paused = {
        run: { ...waiting, pending: [{ pauseId: "p-a", expiresAt: BAD() }] },
        workflowVersion: "1.0.0",
        configHash: "hash",
      };

      const error = await refusalOf(() => store.save(paused as never));

      expect(error.message).toContain("pending[0].expiresAt");
      expect(error.message).toContain("nothing was written");
      expect(await store.findByTenantIdAndThreadId("acme", "thread-1")).toBeUndefined();
    });
  },
);
