import { expect } from "vitest";
import type { PausedExecutionRepository } from "../../infrastructure/paused-execution.repository.js";
import type { ContractCase } from "./define.js";
import { DEADLINE, expiringPauseOf, MID } from "./paused-execution-data.js";
import { type Instances, R } from "./paused-execution-reassign-data.js";

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
        {
          pauseId: "pause-b",
          assignees: ["risk-1", "risk-2", "risk-3"],
          actor: { id: "counsel-4", orgId: "subsidiary-eu" },
          reason: "over the legal limit",
        },
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
          target: old.channel,
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
];
