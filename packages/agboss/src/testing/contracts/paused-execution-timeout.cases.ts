import { expect } from "vitest";
import { PauseExpiryBound } from "../../infrastructure/pause-record.js";
import { NO_RECIPIENTS, type PauseTimeoutChange } from "../../infrastructure/pause-notices.js";
import type { PausedExecutionRepository } from "../../infrastructure/paused-execution.repository.js";
import type { ContractCase } from "./define.js";
import type { ContractInstances } from "./instance-context.js";
import { DEADLINE, expiringPauseOf, MID, pauseOf, withSeen } from "./paused-execution-data.js";

/**
 * #1307: what a timeout change may do to a pause's deadline — shorten it, set one on a pause with none,
 * take it away — and what it writes: the chain of custody (who, why) and the chain's `maxExtensions`,
 * checked atomically with the write. Always over the deadline the caller read, after the moment of the write.
 */
type Instances = ContractInstances<PausedExecutionRepository>;
const R = NO_RECIPIENTS;
const LATER = new Date("2026-01-05T12:00:00.000Z");
const EVEN_LATER = new Date("2026-01-05T15:00:00.000Z");
/** After `MID` and before the deadline of `expiringPauseOf`. */
const EARLIER = new Date("2026-01-05T09:50:00.000Z");
/** The deadline of `expiringPauseOf`: what a caller that read the pause holds as the current one. */
const FROM = DEADLINE;

export const TIMEOUT_CHANGE_CASES: readonly ContractCase<PausedExecutionRepository>[] = [
  {
    name: "a timeout change may shorten: to an earlier deadline after the moment of the write, over the deadline the caller read; never to the moment or the past (#1307)",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(expiringPauseOf("pause-a"));
      const change = async (expiresAt: Date, previousExpiresAt: Date) =>
        second.changeTimeoutByTenantIdAndPauseId(
          "default",
          "pause-a",
          await withSeen(second, "pause-a", { expiresAt, previousExpiresAt }),
          MID,
          R,
        );

      // to the moment, or before it: refused, even when the caller read the stored deadline right
      expect(await change(MID, FROM)).toBeUndefined();
      expect(await change(new Date("2026-01-05T09:00:00.000Z"), FROM)).toBeUndefined();
      // earlier than the stored deadline, after the moment: taken
      expect(await change(EARLIER, FROM)).toMatchObject({
        expiresAt: EARLIER,
        expiryBound: PauseExpiryBound.Pause,
      });
      // the same deadline again over itself is a change too; a later one over it likewise
      expect(await change(EARLIER, EARLIER)).toMatchObject({ expiresAt: EARLIER });
      expect(await change(LATER, EARLIER)).toMatchObject({ expiresAt: LATER });
      // a stale read of the deadline is refused whatever it asks
      expect(await change(EARLIER, FROM)).toBeUndefined();
      expect((await first.findByTenantIdAndPauseId("default", "pause-a"))?.expiresAt).toEqual(LATER);
    },
  },
  {
    name: "a pause with no deadline takes one only over none, and a deadline is taken away over the one read (#1307)",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(pauseOf("pause-a"));
      await first.findOrCreateByStepKey(expiringPauseOf("pause-b", "run-1:s:1:call-2"));
      const change = async (pauseId: string, request: Omit<PauseTimeoutChange, "seen">) =>
        second.changeTimeoutByTenantIdAndPauseId(
          "default",
          pauseId,
          await withSeen(second, pauseId, request),
          MID,
          R,
        );

      // a caller that read a deadline of a pause with none is stale; one that read none is right
      expect(
        await change("pause-a", { expiresAt: LATER, previousExpiresAt: FROM }),
      ).toBeUndefined();
      expect(await change("pause-a", { expiresAt: LATER })).toMatchObject({ expiresAt: LATER });
      expect(await change("pause-a", { expiresAt: EVEN_LATER })).toBeUndefined();
      // taken away over the deadline read; the record keeps none, and its source is the pause's own
      expect(await change("pause-b", { previousExpiresAt: LATER })).toBeUndefined();
      const taken = await change("pause-b", { previousExpiresAt: FROM });
      expect(taken?.expiresAt).toBeUndefined();
      expect(taken?.expiryBound).toBe(PauseExpiryBound.Pause);
      const stored = await first.findByTenantIdAndPauseId("default", "pause-b");
      expect(stored?.pauseId).toBe("pause-b");
      expect(stored?.expiresAt).toBeUndefined();
      // none over none is a change that applies once more (its chain entry says so)
      expect(await change("pause-b", {})).toBeDefined();
    },
  },
  {
    name: "a timeout change is written to the chain of custody with who and why, and counted against `maxExtensions` atomically with the write (#1307)",
    run: async ({ first, second }: Instances): Promise<void> => {
      // the limit is the record's own: it was opened under `maxExtensions: 2`
      await first.findOrCreateByStepKey(
        expiringPauseOf("pause-a", "run-1:clerk-agent:1:call-1", {
          escalationLimits: { maxExtensions: 2 },
        }),
      );
      const change = async (expiresAt: Date, previousExpiresAt: Date) =>
        second.changeTimeoutByTenantIdAndPauseId(
          "default",
          "pause-a",
          await withSeen(second, "pause-a", {
            expiresAt,
            previousExpiresAt,
            actor: { id: "manager-17" },
            reason: "escalated",
          }),
          MID,
          R,
        );

      const moved = await change(EARLIER, FROM);
      expect(moved?.trail.at(-1)).toMatchObject({
        action: "timeout-changed",
        at: MID,
        actor: { id: "manager-17" },
        expiresAt: EARLIER,
        reason: "escalated",
      });
      // the second change is the last one the record's limit of 2 allows; a third is refused
      expect(await change(LATER, EARLIER)).toMatchObject({ expiresAt: LATER });
      expect(await change(EVEN_LATER, LATER)).toBeUndefined();
      const stored = await first.findByTenantIdAndPauseId("default", "pause-a");
      expect(stored?.expiresAt).toEqual(LATER);
      expect(stored?.trail.filter((entry) => entry.action === "timeout-changed")).toHaveLength(2);
    },
  },
  {
    name: "a timeout change is made over the pause as it was read: a change, a reassignment in place or a send marked between the read and the write makes it lose (#1307)",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(pauseOf("pause-a"));
      await first.findOrCreateByStepKey(expiringPauseOf("pause-b", "run-1:s:1:call-2"));
      const read = async (pauseId: string) => (await withSeen(second, pauseId, {})).seen;
      const change = (pauseId: string, seen: PauseTimeoutChange["seen"], deadline?: Date) =>
        second.changeTimeoutByTenantIdAndPauseId(
          "default",
          pauseId,
          {
            seen,
            ...(deadline === undefined ? {} : { expiresAt: LATER, previousExpiresAt: deadline }),
          },
          MID,
          R,
        );

      // none over none from a read that a change has outdated: the deadline is the same, the chain is not
      const stale = await read("pause-a");
      expect(await change("pause-a", stale)).toBeDefined();
      expect(await change("pause-a", stale)).toBeUndefined();
      expect(await change("pause-a", await read("pause-a"))).toBeDefined();
      // the same deadline over itself from an outdated read
      const staleB = await read("pause-b");
      expect(await change("pause-b", staleB, FROM)).toMatchObject({ expiresAt: LATER });
      expect(await change("pause-b", staleB, LATER)).toBeUndefined();
      // the assignees and the sent mark of the read are the pause's now
      const assigned = await read("pause-b");
      expect(
        await change("pause-b", { ...assigned, assignees: ["somebody"] }, LATER),
      ).toBeUndefined();
      expect(
        await change("pause-b", { ...assigned, isSent: !assigned.isSent }, LATER),
      ).toBeUndefined();
      expect(await change("pause-b", assigned, LATER)).toMatchObject({ expiresAt: LATER });
    },
  },
  {
    name: "an in-place reassignment between the read and the write makes a timeout change lose, though it keeps the deadline (#1307)",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(expiringPauseOf("pause-a"));
      const read = await withSeen(second, "pause-a", { expiresAt: LATER, previousExpiresAt: FROM });
      const moved = await first.reassignByTenantIdAndPauseId(
        "default",
        "pause-a",
        { assignees: ["deputy-1"], seen: read.seen },
        MID,
        R,
      );
      expect(moved?.expiresAt).toEqual(FROM);

      expect(
        await second.changeTimeoutByTenantIdAndPauseId("default", "pause-a", read, MID, R),
      ).toBeUndefined();
      const stored = await first.findByTenantIdAndPauseId("default", "pause-a");
      expect(stored?.expiresAt).toEqual(FROM);
      expect(stored?.assignees).toEqual(["deputy-1"]);
      const fresh = await withSeen(second, "pause-a", {
        expiresAt: LATER,
        previousExpiresAt: FROM,
      });
      expect(
        await second.changeTimeoutByTenantIdAndPauseId("default", "pause-a", fresh, MID, R),
      ).toMatchObject({
        expiresAt: LATER,
      });
    },
  },
  {
    name: "a timeout change stores the reminder it is given, and clears the old one when it is given none (#1307)",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(expiringPauseOf("pause-a"));
      const remindAt = new Date("2026-01-05T09:55:00.000Z");
      const change = async (expiresAt: Date, previousExpiresAt: Date, remind?: Date) =>
        second.changeTimeoutByTenantIdAndPauseId(
          "default",
          "pause-a",
          await withSeen(second, "pause-a", {
            expiresAt,
            previousExpiresAt,
            ...(remind === undefined ? {} : { remindAt: remind }),
          }),
          MID,
          R,
        );

      expect((await change(EARLIER, FROM, remindAt))?.remindAt).toEqual(remindAt);
      expect((await first.findByTenantIdAndPauseId("default", "pause-a"))?.remindAt).toEqual(remindAt);
      expect((await change(LATER, EARLIER))?.remindAt).toBeUndefined();
      expect(
        (await first.findByTenantIdAndPauseId("default", "pause-a"))?.remindAt,
      ).toBeUndefined();
    },
  },
];
