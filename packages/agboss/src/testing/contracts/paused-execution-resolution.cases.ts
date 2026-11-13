import { expect } from "vitest";
import {
  PauseResolution,
  PauseStatus,
  type PausedExecutionRepository,
} from "../../infrastructure/paused-execution.repository.js";
import { NO_RECIPIENTS } from "../../infrastructure/pause-notices.js";
import type { ContractCase } from "./define.js";
import type { ContractInstances } from "./instance-context.js";

/** What each case below gets. */
type Instances = ContractInstances<PausedExecutionRepository>;
import {
  APPROVED_BY_MANAGER,
  DECIDED_ANSWER,
  NINE,
  pauseOf,
  TEN,
} from "./paused-execution-data.js";

/** #265 AC11 / #267 AC12: a pause goes from Pending to Resolved once. */
export const PAUSE_TRANSITION_CASES: readonly ContractCase<PausedExecutionRepository>[] = [
  {
    name: "of two concurrent transitions of one pause on two instances exactly one succeeds, with its decision",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(pauseOf("pause-a"));
      const no = { decision: { approved: false }, answeredBy: "manager-18" };

      const [one, other] = await Promise.all([
        first.resolveByTenantIdAndPauseId(
          "default",
          "pause-a",
          APPROVED_BY_MANAGER,
          NINE,
          NO_RECIPIENTS,
        ),
        second.resolveByTenantIdAndPauseId("default", "pause-a", no, NINE, NO_RECIPIENTS),
      ]);

      // two instances are two connections: which answer reaches the store first is not the call
      // order (#704) — exactly one resolves the pause, and the stored pause holds that one's answer
      const outcomes = [one, other].filter((pause) => pause !== undefined);
      expect(outcomes).toHaveLength(1);
      const replied = {
        status: PauseStatus.Resolved,
        answer: one === undefined ? no : APPROVED_BY_MANAGER,
        resolution: PauseResolution.Replied,
        resolvedAt: NINE.toISOString(),
      };
      expect(outcomes[0]).toMatchObject(replied);
      expect(await second.findByTenantIdAndPauseId("default", "pause-a")).toMatchObject(replied);
      expect(
        await first.resolveByTenantIdAndPauseId(
          "default",
          "no-such-pause",
          APPROVED_BY_MANAGER,
          NINE,
          NO_RECIPIENTS,
        ),
      ).toBeUndefined();
    },
  },
  {
    name: "a fast reply before `send` returns: markSent marks it sent, says it is no longer pending and does not overwrite the resolved pause",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(pauseOf("pause-a"));

      await second.resolveByTenantIdAndPauseId(
        "default",
        "pause-a",
        DECIDED_ANSWER,
        NINE,
        NO_RECIPIENTS,
      );
      const marked = await first.markSentByTenantIdAndPauseId("default", "pause-a", NO_RECIPIENTS);

      expect(marked).toBe(false);
      expect(await first.findByTenantIdAndPauseId("default", "pause-a")).toMatchObject({
        status: PauseStatus.Resolved,
        isSent: true,
        answer: { decision: { approved: true } },
      });
    },
  },
  {
    name: "a cancelled pause takes no answer and cannot be cancelled again",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(pauseOf("pause-a"));

      const withdrawn = PauseResolution.Withdrawn;
      const closed = await first.cancelByTenantIdAndPauseId(
        "default",
        "pause-a",
        withdrawn,
        NINE,
        NO_RECIPIENTS,
      );
      expect(closed).toMatchObject({ status: PauseStatus.Cancelled, resolution: withdrawn });
      const cancelled = PauseResolution.Cancelled;
      expect(
        await second.cancelByTenantIdAndPauseId(
          "default",
          "pause-a",
          cancelled,
          TEN,
          NO_RECIPIENTS,
        ),
      ).toBeUndefined();
      expect(
        await second.resolveByTenantIdAndPauseId(
          "default",
          "pause-a",
          APPROVED_BY_MANAGER,
          TEN,
          NO_RECIPIENTS,
        ),
      ).toBeUndefined();
      expect(await second.findByTenantIdAndPauseId("default", "pause-a")).toMatchObject({
        status: PauseStatus.Cancelled,
        resolution: PauseResolution.Withdrawn,
        resolvedAt: NINE.toISOString(),
      });
    },
  },
];
