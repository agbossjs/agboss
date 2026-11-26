import { expect } from "vitest";
import { PauseExpiryBound } from "../../infrastructure/pause-record.js";
import { NO_RECIPIENTS, type PauseTimeoutChange } from "../../infrastructure/pause-notices.js";
import type { PausedExecutionRepository } from "../../infrastructure/paused-execution.repository.js";
import type { ContractCase } from "./define.js";
import type { ContractInstances } from "./instance-context.js";
import { DEADLINE, expiringPauseOf, MID, pauseOf } from "./paused-execution-data.js";

/**
 * #1307: what a timeout change may do to a pause's deadline — shorten it, set one on a pause with none,
 * take it away — and what it writes: the chain of custody (who, why) and the chain's `maxExtensions`,
 * checked atomically with the write. Always over the deadline the caller read, after the moment of the write.
 */
type Instances = ContractInstances<PausedExecutionRepository>;
const R = NO_RECIPIENTS;
const LATER = "2026-01-05T12:00:00.000Z";
const EVEN_LATER = "2026-01-05T15:00:00.000Z";
/** After `MID` and before the deadline of `expiringPauseOf`. */
const EARLIER = "2026-01-05T09:50:00.000Z";
/** The deadline of `expiringPauseOf`: what a caller that read the pause holds as the current one. */
const FROM = DEADLINE.toISOString();

export const TIMEOUT_CHANGE_CASES: readonly ContractCase<PausedExecutionRepository>[] = [
  {
    name: "a timeout change may shorten: to an earlier deadline after the moment of the write, over the deadline the caller read; never to the moment or the past (#1307)",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(expiringPauseOf("pause-a"));
      const change = (expiresAt: string, previousExpiresAt: string) =>
        second.changeTimeoutByTenantIdAndPauseId(
          "default",
          "pause-a",
          { expiresAt, previousExpiresAt },
          MID,
          R,
        );

      // to the moment, or before it: refused, even when the caller read the stored deadline right
      expect(await change(MID.toISOString(), FROM)).toBeUndefined();
      expect(await change("2026-01-05T09:00:00.000Z", FROM)).toBeUndefined();
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
      expect((await first.findByTenantIdAndPauseId("default", "pause-a"))?.expiresAt).toBe(LATER);
    },
  },
  {
    name: "a pause with no deadline takes one only over none, and a deadline is taken away over the one read (#1307)",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(pauseOf("pause-a"));
      await first.findOrCreateByStepKey(expiringPauseOf("pause-b", "run-1:s:1:call-2"));
      const change = (pauseId: string, request: PauseTimeoutChange) =>
        second.changeTimeoutByTenantIdAndPauseId("default", pauseId, request, MID, R);

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
      await first.findOrCreateByStepKey(expiringPauseOf("pause-a"));
      const change = (expiresAt: string, previousExpiresAt: string, maxExtensions: number) =>
        second.changeTimeoutByTenantIdAndPauseId(
          "default",
          "pause-a",
          {
            expiresAt,
            previousExpiresAt,
            actor: { id: "manager-17" },
            reason: "escalated",
            maxExtensions,
          },
          MID,
          R,
        );

      const moved = await change(EARLIER, FROM, 2);
      expect(moved?.trail.at(-1)).toMatchObject({
        action: "timeout-changed",
        at: MID.toISOString(),
        actor: { id: "manager-17" },
        expiresAt: EARLIER,
        reason: "escalated",
      });
      // the second change is the last one the limit of 2 allows; a third, or a limit of 1, is refused
      expect(await change(LATER, EARLIER, 1)).toBeUndefined();
      expect(await change(LATER, EARLIER, 2)).toMatchObject({ expiresAt: LATER });
      expect(await change(EVEN_LATER, LATER, 2)).toBeUndefined();
      const stored = await first.findByTenantIdAndPauseId("default", "pause-a");
      expect(stored?.expiresAt).toBe(LATER);
      expect(stored?.trail.filter((entry) => entry.action === "timeout-changed")).toHaveLength(2);
    },
  },
];
