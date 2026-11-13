import { expect } from "vitest";
import { PauseExpiryBound } from "../../infrastructure/pause-record.js";
import { NO_RECIPIENTS } from "../../infrastructure/pause-notices.js";
import {
  PauseResolution,
  PauseStatus,
  type PausedExecutionRepository,
} from "../../infrastructure/paused-execution.repository.js";
import type { ContractCase } from "./define.js";
import type { ContractInstances } from "./instance-context.js";
import {
  APPROVED_BY_MANAGER,
  BEFORE_DEADLINE,
  DEADLINE,
  expiringPauseOf,
  pauseOf,
  MID,
} from "./paused-execution-data.js";

/** #910 I3: extend, remind and close-untaken — each only in its own state, once. */
type Instances = ContractInstances<PausedExecutionRepository>;
const R = NO_RECIPIENTS;
const LATER = "2026-01-05T12:00:00.000Z";

export const EXTEND_CASES: readonly ContractCase<PausedExecutionRepository>[] = [
  {
    name: "extend only while Pending and before `expiresAt`; never to a past time",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(expiringPauseOf("pause-a"));
      const extend = (at: Date, expiresAt: string) =>
        second.extendByTenantIdAndPauseId("default", "pause-a", { expiresAt }, at, R);

      expect(await extend(BEFORE_DEADLINE, BEFORE_DEADLINE.toISOString())).toBeUndefined();
      expect(await extend(DEADLINE, LATER)).toBeUndefined();
      const moved = await extend(BEFORE_DEADLINE, LATER);

      expect(moved).toMatchObject({ expiresAt: LATER, expiryBound: PauseExpiryBound.Pause });
      expect(moved?.remindAt).toBeUndefined();
      expect((await first.findByTenantIdAndPauseId("default", "pause-a"))?.expiresAt).toBe(LATER);
    },
  },
  {
    name: "a pause without a deadline, or one no longer Pending, is not extended",
    run: async ({ first }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(pauseOf("pause-a"));
      await first.findOrCreateByStepKey(expiringPauseOf("pause-b", "run-1:s:1:call-2"));
      await first.resolveByTenantIdAndPauseId(
        "default",
        "pause-b",
        APPROVED_BY_MANAGER,
        BEFORE_DEADLINE,
        R,
      );

      expect(
        await first.extendByTenantIdAndPauseId(
          "default",
          "pause-a",
          { expiresAt: LATER },
          new Date(0),
          R,
        ),
      ).toBeUndefined();
      expect(
        await first.extendByTenantIdAndPauseId(
          "default",
          "pause-b",
          { expiresAt: LATER },
          new Date(0),
          R,
        ),
      ).toBeUndefined();
    },
  },
  {
    name: "remind once: the second remind does not apply; not before `remindAt`, not at the deadline",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(expiringPauseOf("pause-a"));
      const remindAt = new Date("2026-01-05T09:30:00.000Z");

      expect(
        await first.remindByTenantIdAndPauseId(
          "default",
          "pause-a",
          new Date(remindAt.getTime() - 1),
          R,
        ),
      ).toBe(false);
      const results = await Promise.all([
        first.remindByTenantIdAndPauseId("default", "pause-a", remindAt, R),
        second.remindByTenantIdAndPauseId("default", "pause-a", remindAt, R),
      ]);

      expect(results.filter(Boolean)).toHaveLength(1);
      expect(
        (await first.findByTenantIdAndPauseId("default", "pause-a"))?.remindAt,
      ).toBeUndefined();
      await first.findOrCreateByStepKey(expiringPauseOf("pause-b", "run-1:s:1:call-2"));
      expect(await first.remindByTenantIdAndPauseId("default", "pause-b", DEADLINE, R)).toBe(false);
    },
  },
  {
    name: "closeUntaken applies only to a Resolved pause: Cancelled or TreeEnded, the answer kept, once",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(pauseOf("pause-a"));
      expect(
        await first.closeUntakenByTenantIdAndPauseId(
          "default",
          "pause-a",
          PauseResolution.TreeEnded,
          MID,
          R,
        ),
      ).toBeUndefined();
      await first.resolveByTenantIdAndPauseId("default", "pause-a", APPROVED_BY_MANAGER, MID, R);

      const closed = await second.closeUntakenByTenantIdAndPauseId(
        "default",
        "pause-a",
        PauseResolution.TreeEnded,
        DEADLINE,
        R,
      );
      const again = await first.closeUntakenByTenantIdAndPauseId(
        "default",
        "pause-a",
        PauseResolution.Cancelled,
        DEADLINE,
        R,
      );

      expect(closed).toMatchObject({
        status: PauseStatus.Cancelled,
        resolution: PauseResolution.TreeEnded,
        answer: APPROVED_BY_MANAGER,
        resolvedAt: DEADLINE.toISOString(),
      });
      expect(again).toBeUndefined();
    },
  },
  {
    name: "findByTenantIdAndRootExecutionIdAndStepKey finds only that tree's step",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(pauseOf("pause-a"));
      await first.findOrCreateByStepKey({ ...pauseOf("pause-b"), rootExecutionId: "run-2" });

      expect(
        (
          await second.findByTenantIdAndRootExecutionIdAndStepKey(
            "default",
            "run-2",
            "run-1:clerk-agent:1:call-1",
          )
        )?.pauseId,
      ).toBe("pause-b");
      expect(
        (
          await second.findByTenantIdAndRootExecutionIdAndStepKey(
            "default",
            "run-1",
            "run-1:clerk-agent:1:call-1",
          )
        )?.pauseId,
      ).toBe("pause-a");
      expect(
        await second.findByTenantIdAndRootExecutionIdAndStepKey(
          "default",
          "run-3",
          "run-1:clerk-agent:1:call-1",
        ),
      ).toBeUndefined();
      expect(
        await second.findByTenantIdAndRootExecutionIdAndStepKey(
          "acme",
          "run-1",
          "run-1:clerk-agent:1:call-1",
        ),
      ).toBeUndefined();
    },
  },
];
