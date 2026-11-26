import { expect } from "vitest";
import type { PausedExecutionRepository } from "../../infrastructure/paused-execution.repository.js";
import type { ContractCase } from "./define.js";
import {
  PauseExpiryBound,
  PauseResolution,
  PauseStatus,
} from "../../infrastructure/pause-record.js";
import {
  AFTER_DEADLINE,
  DEADLINE,
  expiringPauseOf,
  MID,
  withSeenNow,
} from "./paused-execution-data.js";
import { type Instances, R, reassignWith } from "./paused-execution-reassign-data.js";

/** #1307d: what a reassignment writes into a pause's chain of custody and its pool of assignees. */
export const REASSIGN_TRAIL_CASES: readonly ContractCase<PausedExecutionRepository>[] = [
  {
    name: "a reassignment keeps who did it and why in the replacement's trail, names a pool of assignees, and drops the old pause's external reference; the old pause keeps its own record",
    run: async ({ first, second }: Instances): Promise<void> => {
      const old = { ...expiringPauseOf("pause-a"), externalRef: "JIRA-17" };
      await first.findOrCreateByStepKey(old);

      const replacement = await first.reassignByTenantIdAndPauseId(
        "default",
        "pause-a",
        await withSeenNow(first, "pause-a", {
          pauseId: "pause-b",
          assignees: ["risk-1", "risk-2", "risk-3"],
          actor: { id: "counsel-4", orgId: "subsidiary-eu" },
          reason: "over the legal limit",
        }),
        MID,
        R,
      );

      expect(replacement?.assignees).toEqual(["risk-1", "risk-2", "risk-3"]);
      expect(replacement).not.toHaveProperty("externalRef");
      expect(replacement?.trail).toEqual([
        ...old.trail,
        {
          action: "reassigned",
          at: MID.toISOString(),
          actor: { id: "counsel-4", orgId: "subsidiary-eu" },
          target: old.target,
          channel: old.channel,
          assignees: ["risk-1", "risk-2", "risk-3"],
          expiresAt: DEADLINE.toISOString(),
          reason: "over the legal limit",
        },
      ]);
      // read back by another instance: the same record, and the old pause as it was but closed
      expect(await second.findByTenantIdAndPauseId("default", "pause-b")).toEqual(replacement);
      const closed = await second.findByTenantIdAndPauseId("default", "pause-a");
      expect(closed).toMatchObject({ externalRef: "JIRA-17", trail: old.trail });
      expect(closed?.assignees).toBeUndefined();
    },
  },
  {
    name: "#1310a: an expiry's reassignment applies only to a due pause (a due-at compare-and-set), gives the replacement the new deadline and no reminder, and an open pause is refused",
    run: async ({ first, second }: Instances): Promise<void> => {
      const old = expiringPauseOf("pause-a");
      await first.findOrCreateByStepKey(old);
      const due = {
        pauseId: "pause-b",
        assignees: ["deputy-1"],
        reason: "no answer",
        due: { expiresAt: "2026-01-05T12:00:00.000Z", expiryBound: PauseExpiryBound.Pause },
      };

      // before the deadline the pause is still open: an expiry's reassignment is not for it
      expect(await reassignWith(first, "pause-a", due, MID, R)).toBeUndefined();
      const moved = await reassignWith(second, "pause-a", due, AFTER_DEADLINE, R);

      expect(moved).toMatchObject({
        pauseId: "pause-b",
        status: PauseStatus.Pending,
        assignees: ["deputy-1"],
        expiresAt: "2026-01-05T12:00:00.000Z",
        expiryBound: PauseExpiryBound.Pause,
        reassignedFrom: "pause-a",
      });
      expect(moved).not.toHaveProperty("remindAt");
      expect(moved?.trail.at(-1)).toMatchObject({
        action: "reassigned",
        expiresAt: "2026-01-05T12:00:00.000Z",
        reason: "no answer",
      });
      expect(await first.findByTenantIdAndPauseId("default", "pause-a")).toMatchObject({
        status: PauseStatus.Cancelled,
        resolution: PauseResolution.Reassigned,
        reassignedTo: "pause-b",
      });
      // a second reassignment of the closed pause loses
      expect(
        await reassignWith(first, "pause-a", { ...due, pauseId: "pause-c" }, AFTER_DEADLINE, R),
      ).toBeUndefined();
    },
  },
];
