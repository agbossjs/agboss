import { expect } from "vitest";
import { type PausedExecutionRepository } from "../../infrastructure/paused-execution.repository.js";
import type { ContractCase } from "./define.js";
import {
  AFTER_DEADLINE,
  DEADLINE,
  expiringPauseOf,
  MID,
  withSeen,
} from "./paused-execution-data.js";
import { CAP, limitedPause, TIGHTER, TO } from "./paused-execution-limits-data.js";
import { type Instances, reassignWith } from "./paused-execution-reassign-data.js";

/** #1307, Q-D: the store itself keeps the cap on a deadline a change sets, whatever the caller planned. */
export const CAP_CASES: readonly ContractCase<PausedExecutionRepository>[] = [
  {
    name: "a deadline past the record's maxExpiresAt (or none at all) is refused by the store itself, atomically, whatever the caller planned: a timeout change",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(limitedPause("pause-a"));
      const change = async (expiresAt: string | undefined) =>
        second.changeTimeoutByTenantIdAndPauseId(
          "default",
          "pause-a",
          await withSeen(second, "pause-a", {
            ...(expiresAt === undefined ? {} : { expiresAt }),
            previousExpiresAt: DEADLINE.toISOString(),
          }),
          MID,
          { listeners: [] },
        );

      expect(await change("2026-01-05T20:00:00.001Z")).toBeUndefined();
      expect(await change(undefined)).toBeUndefined();
      expect((await first.findByTenantIdAndPauseId("default", "pause-a"))?.expiresAt).toBe(
        DEADLINE.toISOString(),
      );
      // exactly the cap is allowed; a pause with no cap takes none-at-all
      expect(await change(CAP)).toMatchObject({ expiresAt: CAP });
      await first.findOrCreateByStepKey(expiringPauseOf("pause-b", "run-1:s:1:call-2"));
      expect(
        await second.changeTimeoutByTenantIdAndPauseId(
          "default",
          "pause-b",
          await withSeen(second, "pause-b", { previousExpiresAt: DEADLINE.toISOString() }),
          MID,
          { listeners: [] },
        ),
      ).toBeDefined();
    },
  },
  {
    name: "a deadline a reassignment sets keeps the cap too: in place, an operator's replacement narrowed by the destination, and an expiry's",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(limitedPause("pause-a"));
      const inPlace = (expiresAt: string) =>
        reassignWith(second, "pause-a", { assignees: ["x"], timeout: { expiresAt } }, MID);

      expect(await inPlace("2026-01-05T20:00:00.001Z")).toBeUndefined();
      expect(await inPlace(CAP)).toMatchObject({ expiresAt: CAP });

      // the destination's tighter cap applies to the deadline of the move itself
      await first.findOrCreateByStepKey(limitedPause("pause-b", "run-1:s:1:call-2"));
      const to = { ...TO, limits: { maxExpiresAt: TIGHTER } };
      const move = (pauseId: string, expiresAt: string) =>
        reassignWith(first, "pause-b", { pauseId, to, timeout: { expiresAt } }, MID);
      expect(await move("pause-c", CAP)).toBeUndefined();
      expect(await first.findByTenantIdAndPauseId("default", "pause-c")).toBeUndefined();
      expect(await move("pause-c", TIGHTER)).toMatchObject({ maxExpiresAt: TIGHTER });

      // an expiry's reassignment that sets no deadline under a cap
      await first.findOrCreateByStepKey(limitedPause("pause-d", "run-1:s:1:call-3"));
      expect(
        await reassignWith(second, "pause-d", { assignees: ["x"], due: {} }, AFTER_DEADLINE),
      ).toBeUndefined();
      expect(
        await reassignWith(
          second,
          "pause-d",
          { assignees: ["x"], due: { expiresAt: CAP } },
          AFTER_DEADLINE,
        ),
      ).toMatchObject({ expiresAt: CAP });
    },
  },
];
