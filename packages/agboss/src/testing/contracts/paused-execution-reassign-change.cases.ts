import { expect } from "vitest";
import { type PausedExecutionRepository } from "../../infrastructure/paused-execution.repository.js";
import type { ContractCase } from "./define.js";
import {
  CHANNEL_KEY,
  DEADLINE,
  expiringPauseOf,
  MID,
  RECIPIENTS,
  withSeenNow,
} from "./paused-execution-data.js";
import { kindsOf, noticesOf, peeker } from "./paused-execution-mailboxes.js";
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
      // what the channel's system needs to find and update its old item
      const told = noticesOf(claims, "pause-a", CHANNEL_KEY)[0];
      expect(told).toMatchObject({
        writtenAt: MID.toISOString(),
        assignees: ["deputy-3"],
        expiresAt: DEADLINE.toISOString(),
        previousExpiresAt: DEADLINE.toISOString(),
        previousTarget: "refund-tool-approval",
        previousChannel: "refund-approval-channel",
        previousExternalRef: "JIRA-1",
      });
      expect(told).not.toHaveProperty("previousAssignees");
    },
  },
  {
    name: "an in-place change with no assignees releases the pause; the record's maxReassignments refuses one past it atomically; a due change applies only to a due pause",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(
        expiringPauseOf("pause-a", "run-1:clerk-agent:1:call-1", {
          escalationLimits: { maxReassignments: 1 },
        }),
      );
      const reassign = async (store: Instances["first"], pauseId: string, change: object) =>
        store.reassignByTenantIdAndPauseId(
          "default",
          pauseId,
          await withSeenNow(store, pauseId, change),
          MID,
          R,
        );
      const change = { assignees: ["deputy-3"] };
      expect(await reassign(second, "pause-a", change)).toMatchObject({ assignees: ["deputy-3"] });

      // the chain holds one reassignment: no second one, whoever asks, whatever the change says
      expect(await reassign(first, "pause-a", change)).toBeUndefined();
      expect(await reassign(first, "pause-a", {})).toBeUndefined();
      expect((await first.findByTenantIdAndPauseId("default", "pause-a"))?.assignees).toEqual([
        "deputy-3",
      ]);
      // a pause with no limit is released by a change with no assignees
      await first.findOrCreateByStepKey(expiringPauseOf("pause-r", "run-1:clerk-agent:1:call-2"));
      expect((await reassign(first, "pause-r", {}))?.assignees).toBeUndefined();

      // an expiry's change (due) is refused while the deadline is ahead
      expect(await reassign(first, "pause-a", { due: {} })).toBeUndefined();
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
      await first.findOrCreateByStepKey(
        expiringPauseOf("pause-a", "run-1:clerk-agent:1:call-1", {
          escalationLimits: { maxExtensions: 1 },
        }),
      );
      const limited = { countsAsExtension: true as const };
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
