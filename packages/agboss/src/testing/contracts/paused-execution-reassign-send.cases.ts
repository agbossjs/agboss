import { expect } from "vitest";
import type { PauseReassignmentChange } from "../../infrastructure/pause-notices.js";
import {
  PauseResolution,
  PauseStatus,
  type PausedExecutionRepository,
  type PauseRecord,
} from "../../infrastructure/paused-execution.repository.js";
import type { PauseSeen } from "../../infrastructure/pause-notices.js";
import type { ContractCase } from "./define.js";
import {
  decideNow,
  AFTER_DEADLINE,
  APPROVED_BY_MANAGER,
  BEFORE_DEADLINE,
  CHANNEL_KEY,
  DEADLINE,
  DECIDED_ANSWER,
  expiringPauseOf,
  RECIPIENTS,
  seenNow,
} from "./paused-execution-data.js";
import { kindsOf, noticesOf, peeker } from "./paused-execution-mailboxes.js";
import { AUDIT, type Instances, reassignWith } from "./paused-execution-reassign-data.js";

/** #1307: a reassignment racing a channel's decision, one planned without `seen`, and one made while the first send ran. */
export const REASSIGN_SEND_CASES: readonly ContractCase<PausedExecutionRepository>[] = [
  {
    name: "a reassignment and a channel's decision at once: exactly one wins, whichever starts first, and the pause leaves Pending once",
    run: async ({ first, second }: Instances): Promise<void> => {
      for (const [index, decideFirst] of [true, false].entries()) {
        const old = `pause-${String(index)}`;
        await first.findOrCreateByStepKey(expiringPauseOf(old, `run-1:s:${String(index)}`));
        const planned = await seenNow(second, old);
        const decide = (): Promise<boolean> =>
          decideNow(first, old, DECIDED_ANSWER, BEFORE_DEADLINE);
        const move = (): Promise<PauseRecord | undefined> =>
          second.reassignByTenantIdAndPauseId(
            "default",
            old,
            { pauseId: `${old}-new`, assignees: ["deputy-3"], seen: planned },
            BEFORE_DEADLINE,
            RECIPIENTS,
          );

        const started = decideFirst
          ? { decided: decide(), moved: move() }
          : { moved: move(), decided: decide() };
        const [decided, moved] = [await started.decided, await started.moved];

        expect([decided, moved !== undefined].filter(Boolean)).toHaveLength(1);
        const stored = await first.findByTenantIdAndPauseId("default", old);
        expect(stored?.resolution).toBe(
          moved === undefined ? PauseResolution.Decided : PauseResolution.Reassigned,
        );
        expect((await first.findByTenantIdAndPauseId("default", `${old}-new`)) === undefined).toBe(
          moved === undefined,
        );
      }
    },
  },
  {
    name: "a reassignment with no `seen` (a store caller that skipped the plan) is refused whole, in place or as a replacement, and writes nothing",
    run: async ({ first }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(expiringPauseOf("pause-a"));
      const unplanned = (change: object) =>
        first.reassignByTenantIdAndPauseId(
          "default",
          "pause-a",
          change as PauseReassignmentChange,
          BEFORE_DEADLINE,
          RECIPIENTS,
        );

      expect(await unplanned({ assignees: ["deputy-1"] })).toBeUndefined();
      expect(await unplanned({ pauseId: "pause-b", assignees: ["deputy-1"] })).toBeUndefined();

      const stored = await first.findByTenantIdAndPauseId("default", "pause-a");
      expect(stored).toMatchObject({ status: PauseStatus.Pending });
      expect(stored?.assignees).toBeUndefined();
      expect(stored?.trail).toHaveLength(1);
      expect(await first.findByTenantIdAndPauseId("default", "pause-b")).toBeUndefined();
    },
  },
  {
    name: "an in-place change made while the first send ran (an expiry's, the channel not yet marked asked) writes no notice then; the markSent that follows tells the listeners `opened` and the channel and listeners `reassigned`, once, from the target and channel it was asked on",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(expiringPauseOf("pause-a"));

      const moved = await reassignWith(
        second,
        "pause-a",
        { assignees: ["deputy-3"], due: { expiresAt: new Date("2026-01-05T12:00:00.000Z") } },
        AFTER_DEADLINE,
      );
      expect(moved).toMatchObject({ isSent: false, assignees: ["deputy-3"] });
      expect(await peeker(first)()).toEqual([]);

      await first.markSentByTenantIdAndPauseId("default", "pause-a", RECIPIENTS, "JIRA-1");
      // a second markSent writes nothing more
      await second.markSentByTenantIdAndPauseId("default", "pause-a", RECIPIENTS, "JIRA-1");

      const claims = await peeker(first)();
      expect(kindsOf(claims, "pause-a", CHANNEL_KEY)).toEqual(["reassigned"]);
      expect(kindsOf(claims, "pause-a", AUDIT)).toEqual(["opened", "reassigned"]);
      // `opened` carries the deadline the channel was asked with, `reassigned` the change from it
      expect(noticesOf(claims, "pause-a", AUDIT)[0]).toMatchObject({
        expiresAt: DEADLINE,
      });
      expect(noticesOf(claims, "pause-a", CHANNEL_KEY)[0]).toMatchObject({
        previousExpiresAt: DEADLINE,
        previousTarget: "refund-tool-approval",
        previousChannel: "refund-approval-channel",
        expiresAt: new Date("2026-01-05T12:00:00.000Z"),
        assignees: ["deputy-3"],
      });
    },
  },
  {
    name: "a reassignment planned against an unsent pause is refused once its channel was marked asked — in place or as a replacement — and applies when planned against the sent pause",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(expiringPauseOf("pause-a"));
      const unsent = { trailLength: 1, expiresAt: DEADLINE, isSent: false };
      // the step's send returned meanwhile: its markSent landed between the plan and the write
      await first.markSentByTenantIdAndPauseId("default", "pause-a", RECIPIENTS, "JIRA-1");
      const change = (store: PausedExecutionRepository, seen: typeof unsent, pauseId?: string) =>
        store.reassignByTenantIdAndPauseId(
          "default",
          "pause-a",
          pauseId === undefined
            ? { assignees: ["deputy-1"], seen }
            : { pauseId, assignees: ["deputy-1"], seen },
          BEFORE_DEADLINE,
          RECIPIENTS,
        );

      expect(await change(second, unsent)).toBeUndefined();
      expect(await change(second, unsent, "pause-b")).toBeUndefined();
      const stored = await first.findByTenantIdAndPauseId("default", "pause-a");
      expect(stored).toMatchObject({ status: PauseStatus.Pending, isSent: true });
      expect(stored?.assignees).toBeUndefined();
      expect(stored?.trail).toHaveLength(1);
      expect(await first.findByTenantIdAndPauseId("default", "pause-b")).toBeUndefined();

      // planned against the sent pause: applies
      const sent = { ...unsent, isSent: true };
      expect((await change(second, sent, "pause-b"))?.reassignedFrom).toBe("pause-a");
    },
  },
  {
    name: "a channel's decision at once, given after an expiry changed the pause in place during the first send, is refused: the pause stays Pending with the new assignees and deadline, and is taken only by a decision over what it is now",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(expiringPauseOf("pause-a"));
      // what the step sent: the pause as it was before the send
      const sent = await seenNow(first, "pause-a");
      const later = new Date("2026-01-05T12:00:00.000Z");
      await reassignWith(
        second,
        "pause-a",
        { assignees: ["manager"], due: { expiresAt: later } },
        AFTER_DEADLINE,
      );
      const decidedAt = new Date(AFTER_DEADLINE.getTime() + 60_000);

      expect(
        await first.decideByTenantIdAndPauseId(
          "default",
          "pause-a",
          DECIDED_ANSWER,
          decidedAt,
          sent,
        ),
      ).toBe(false);
      const stored = await first.findByTenantIdAndPauseId("default", "pause-a");
      expect(stored).toMatchObject({ status: PauseStatus.Pending, assignees: ["manager"] });
      expect(stored?.answer).toBeUndefined();
      expect(stored?.expiresAt).toEqual(later);

      // over the pause as it is now, the decision is taken
      expect(await decideNow(second, "pause-a", DECIDED_ANSWER, decidedAt)).toBe(true);
    },
  },
  {
    name: "an answer permitted over the pause as it was (`seen`) is not recorded once an in-place reassignment — an operator's, or an expiry's under a new deadline — changed it: refused untouched; recorded over what the pause is now",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(expiringPauseOf("pause-a"));
      await first.markSentByTenantIdAndPauseId("default", "pause-a", RECIPIENTS, "JIRA-1");
      const resolve = (store: PausedExecutionRepository, seen: PauseSeen, at = BEFORE_DEADLINE) =>
        store.resolveByTenantIdAndPauseId(
          "default",
          "pause-a",
          APPROVED_BY_MANAGER,
          at,
          RECIPIENTS,
          seen,
        );
      const permitted = await seenNow(first, "pause-a");

      // (a) an operator moves it to the manager before the clerk's permitted answer lands
      await reassignWith(second, "pause-a", { assignees: ["manager"] });
      expect(await resolve(first, permitted)).toBeUndefined();
      // (b) the expiry's due-at change under a new deadline: the answer is after the original one
      const later = new Date("2026-01-05T12:00:00.000Z");
      await reassignWith(
        second,
        "pause-a",
        { assignees: ["director"], due: { expiresAt: later } },
        AFTER_DEADLINE,
      );
      const afterDeadline = new Date(AFTER_DEADLINE.getTime() + 60_000);
      expect(await resolve(first, permitted, afterDeadline)).toBeUndefined();
      const stored = await first.findByTenantIdAndPauseId("default", "pause-a");
      expect(stored).toMatchObject({ status: PauseStatus.Pending, assignees: ["director"] });
      expect(stored?.answer).toBeUndefined();

      // permitted over what the pause is now: recorded
      const now = await seenNow(second, "pause-a");
      expect(await resolve(second, now, afterDeadline)).toMatchObject({
        status: PauseStatus.Resolved,
      });
    },
  },
];
