import { expect } from "vitest";
import { type PausedExecutionRepository } from "../../infrastructure/paused-execution.repository.js";
import type { ContractCase } from "./define.js";
import {
  CHANNEL_KEY,
  expiringPauseOf,
  MID,
  RECIPIENTS,
  withSeenNow,
} from "./paused-execution-data.js";
import { kindsOf, peeker } from "./paused-execution-mailboxes.js";
import {
  type Instances,
  R,
  AUDIT,
  treeOf,
  ids,
  reassignWith,
} from "./paused-execution-reassign-data.js";

/** #1307: a reassignment that keeps the pause (in place), and one made to another target. */
export const REASSIGN_CHANGE_CASES: readonly ContractCase<PausedExecutionRepository>[] = [
  {
    name: "a change with no pauseId keeps the pause: assignees replaced, a `reassigned` entry, its externalRef kept, one `reassigned` notice to the channel and the listeners",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(expiringPauseOf("pause-a"));
      await first.markSentByTenantIdAndPauseId("default", "pause-a", RECIPIENTS, "JIRA-1");

      const moved = await second.reassignByTenantIdAndPauseId(
        "default",
        "pause-a",
        await withSeenNow(second, "pause-a", { assignees: ["deputy-3"], reason: "on leave" }),
        MID,
        RECIPIENTS,
      );

      expect(moved).toMatchObject({
        pauseId: "pause-a",
        assignees: ["deputy-3"],
        externalRef: "JIRA-1",
        status: "pending",
      });
      expect(moved?.trail.map((entry) => entry.action)).toEqual(["opened", "reassigned"]);
      expect(moved?.trail[1]).toMatchObject({ reason: "on leave", externalRef: "JIRA-1" });
      expect(ids(await treeOf(first))).toEqual(["pause-a"]);
      const claims = await peeker(first)();
      expect(kindsOf(claims, "pause-a", CHANNEL_KEY)).toEqual(["reassigned"]);
      expect(kindsOf(claims, "pause-a", AUDIT)).toEqual(["opened", "reassigned"]);
    },
  },
  {
    name: "an in-place change with no assignees releases the pause; maxReassignments refuses one past it atomically; a due change applies only to a due pause",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(expiringPauseOf("pause-a"));
      const change = { assignees: ["deputy-3"], maxReassignments: 1 };
      expect(
        await second.reassignByTenantIdAndPauseId(
          "default",
          "pause-a",
          await withSeenNow(second, "pause-a", change),
          MID,
          R,
        ),
      ).toMatchObject({ assignees: ["deputy-3"] });

      // the chain holds one reassignment: no second one, whoever asks
      expect(
        await first.reassignByTenantIdAndPauseId(
          "default",
          "pause-a",
          await withSeenNow(first, "pause-a", change),
          MID,
          R,
        ),
      ).toBeUndefined();
      const released = await first.reassignByTenantIdAndPauseId(
        "default",
        "pause-a",
        await withSeenNow(first, "pause-a", {}),
        MID,
        R,
      );
      expect(released?.assignees).toBeUndefined();

      // an expiry's change (due) is refused while the deadline is ahead
      expect(
        await first.reassignByTenantIdAndPauseId(
          "default",
          "pause-a",
          await withSeenNow(first, "pause-a", { due: {} }),
          MID,
          R,
        ),
      ).toBeUndefined();
    },
  },
  {
    name: "a replacement made `to` another target and channel waits there, unsent, with no externalRef; its markSent keeps the reference the new channel gave",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(expiringPauseOf("pause-a"));
      await first.markSentByTenantIdAndPauseId("default", "pause-a", RECIPIENTS, "JIRA-1");

      const made = await second.reassignByTenantIdAndPauseId(
        "default",
        "pause-a",
        await withSeenNow(second, "pause-a", {
          pauseId: "pause-b",
          to: { target: "tier-two-external-task", respondent: "delegate" as never, channel: "sap" },
          timeout: { expiresAt: "2026-01-05T12:00:00.000Z" },
        }),
        MID,
        RECIPIENTS,
      );

      expect(made).toMatchObject({
        target: "tier-two-external-task",
        channel: "sap",
        isSent: false,
        expiresAt: "2026-01-05T12:00:00.000Z",
      });
      expect(made?.externalRef).toBeUndefined();
      expect(made?.trail.at(-1)).toMatchObject({
        target: "tier-two-external-task",
        channel: "sap",
      });
      await second.markSentByTenantIdAndPauseId("default", "pause-b", RECIPIENTS, "SAP-9");
      const sent = await first.findByTenantIdAndPauseId("default", "pause-b");
      expect(sent).toMatchObject({ externalRef: "SAP-9" });
      expect(sent?.trail.at(-1)?.externalRef).toBe("SAP-9");
    },
  },
  {
    name: "a replacement made with a new deadline counts as an extension: a `timeout-changed` entry after its `reassigned`, and maxExtensions refuses the next one atomically, moved or in place",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(expiringPauseOf("pause-a"));
      const limited = { countsAsExtension: true as const, maxExtensions: 1 };
      const to = { target: "tier-one-external-task", respondent: "delegate" as never };

      const made = await reassignWith(
        second,
        "pause-a",
        {
          pauseId: "pause-b",
          to: { ...to, channel: "backup" },
          timeout: { expiresAt: "2026-01-05T12:00:00.000Z" },
          ...limited,
        },
        MID,
      );
      expect(made?.trail.map((entry) => entry.action)).toEqual([
        "opened",
        "reassigned",
        "timeout-changed",
      ]);
      expect(made?.trail.at(-1)).toMatchObject({ channel: "backup" });

      // the chain holds one extension: no second, moved back or changed in place
      const again = {
        timeout: { expiresAt: "2026-01-05T14:00:00.000Z" },
        ...limited,
      };
      const moved = { pauseId: "pause-c", to: { ...to, channel: "main" }, ...again };
      expect(await reassignWith(first, "pause-b", moved, MID, R)).toBeUndefined();
      expect(
        await reassignWith(first, "pause-b", { assignees: ["deputy-3"], ...again }, MID, R),
      ).toBeUndefined();
      expect(await first.findByTenantIdAndPauseId("default", "pause-c")).toBeUndefined();
      expect((await first.findByTenantIdAndPauseId("default", "pause-b"))?.expiresAt).toBe(
        "2026-01-05T12:00:00.000Z",
      );
    },
  },
];
