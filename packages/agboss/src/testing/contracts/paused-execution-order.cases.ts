import { expect } from "vitest";
import { PauseClosedReason } from "../../infrastructure/pause-record.js";
import { PauseNoticeKind } from "../../infrastructure/pause-notices.js";
import {
  PauseResolution,
  type PausedExecutionRepository,
} from "../../infrastructure/paused-execution.repository.js";
import { seconds } from "../../units/index.js";
import type { ContractCase } from "./define.js";
import type { ContractInstances } from "./instance-context.js";
import {
  APPROVED_BY_MANAGER,
  BEFORE_DEADLINE,
  CHANNEL_KEY,
  DEADLINE,
  expiringPauseOf,
  LISTENER_KEYS,
  RECIPIENTS,
  MID,
} from "./paused-execution-data.js";
import { kindsOf, noticesOf, peeker } from "./paused-execution-mailboxes.js";

/** #910 AC2, I8: the order of a mailbox, the head, the notice that goes once, every transition. */
type Instances = ContractInstances<PausedExecutionRepository>;
const [AUDIT] = LISTENER_KEYS;
const DAY1 = new Date("2026-01-05T10:00:00.000Z");
const DAY2 = new Date("2026-01-06T10:00:00.000Z");
const DAY3 = new Date("2026-01-07T10:00:00.000Z");

const pauseA = (): ReturnType<typeof expiringPauseOf> => expiringPauseOf("pause-a");

export const NOTICE_ORDER_CASES: readonly ContractCase<PausedExecutionRepository>[] = [
  {
    name: "closeUntaken of a sent pause writes answerNotTaken to channel and listeners after their closed",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(pauseA());
      await first.markSentByTenantIdAndPauseId("default", "pause-a", RECIPIENTS);
      await first.resolveByTenantIdAndPauseId(
        "default",
        "pause-a",
        APPROVED_BY_MANAGER,
        MID,
        RECIPIENTS,
      );

      await second.closeUntakenByTenantIdAndPauseId(
        "default",
        "pause-a",
        PauseResolution.TreeEnded,
        DEADLINE,
        RECIPIENTS,
      );

      const claims = await peeker(first)();
      expect(kindsOf(claims, "pause-a", CHANNEL_KEY)).toEqual(["closed", "answer-not-taken"]);
      expect(kindsOf(claims, "pause-a", AUDIT)).toEqual(["opened", "closed", "answer-not-taken"]);
      expect(noticesOf(claims, "pause-a", CHANNEL_KEY)[1]).toMatchObject({
        reason: PauseClosedReason.TreeEnded,
        closedAt: DEADLINE.toISOString(),
      });
    },
  },
  {
    name: "closeUntaken of an unsent pause writes nothing; its markSent writes opened, closed, answerNotTaken in that order",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(pauseA());
      await first.resolveByTenantIdAndPauseId(
        "default",
        "pause-a",
        APPROVED_BY_MANAGER,
        MID,
        RECIPIENTS,
      );
      await first.closeUntakenByTenantIdAndPauseId(
        "default",
        "pause-a",
        PauseResolution.Cancelled,
        DEADLINE,
        RECIPIENTS,
      );
      expect(await peeker(first)()).toEqual([]);

      await second.markSentByTenantIdAndPauseId("default", "pause-a", RECIPIENTS);

      const claims = await peeker(first)();
      expect(kindsOf(claims, "pause-a", CHANNEL_KEY)).toEqual(["closed", "answer-not-taken"]);
      expect(kindsOf(claims, "pause-a", AUDIT)).toEqual(["opened", "closed", "answer-not-taken"]);
      expect(noticesOf(claims, "pause-a", AUDIT).map((notice) => notice.seq)).toEqual([1, 2, 3]);
      expect(noticesOf(claims, "pause-a", CHANNEL_KEY)[1]?.reason).toBe(
        PauseClosedReason.Cancelled,
      );
    },
  },
  {
    name: "noticeOnce twice (two instances) → one joinFailed notice; on a Taken pause too; none for an unsent pause",
    run: async ({ first, second }: Instances): Promise<void> => {
      const facts = { launch: "run-1:clerk-agent:1", errorCode: "step.pause-expired" };
      const once = (store: PausedExecutionRepository, id: string) =>
        store.noticeOnceByTenantIdAndPauseId(
          "default",
          id,
          PauseNoticeKind.JoinFailed,
          facts,
          MID,
          RECIPIENTS,
        );
      await first.findOrCreateByStepKey(expiringPauseOf("pause-a", "run-1:s:1:a"));
      await first.findOrCreateByStepKey(expiringPauseOf("pause-b", "run-1:s:1:b"));
      await first.markSentByTenantIdAndPauseId("default", "pause-a", RECIPIENTS);
      await first.resolveByTenantIdAndPauseId(
        "default",
        "pause-a",
        APPROVED_BY_MANAGER,
        BEFORE_DEADLINE,
        RECIPIENTS,
      );
      await first.markTakenByTenantIdAndPauseId("default", "pause-a");

      const results = await Promise.all([once(first, "pause-a"), once(second, "pause-a")]);

      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await once(first, "pause-b")).toBe(false);
      expect(await once(first, "no-such-pause")).toBe(false);
      const claims = await peeker(first)();
      expect(kindsOf(claims, "pause-a", CHANNEL_KEY)).toEqual(["closed", "join-failed"]);
      expect(noticesOf(claims, "pause-a", CHANNEL_KEY)[1]).toMatchObject(facts);
      expect(kindsOf(claims, "pause-b", AUDIT)).toEqual([]);
    },
  },
  {
    name: "opened acknowledged on day 1, closed appended on day 3: it is due at once, its head is day 3, it is not set aside by a look at day 2",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(pauseA());
      await first.markSentByTenantIdAndPauseId("default", "pause-a", RECIPIENTS);
      const [opened] = await first.claimNoticesDue(DAY1, 10, seconds(60), [AUDIT]);
      expect(opened).toBeDefined();
      if (opened === undefined) return;
      expect(await first.ackNotice(opened, DAY1)).toBeUndefined();

      await second.cancelByTenantIdAndPauseId(
        "default",
        "pause-a",
        PauseResolution.Withdrawn,
        DAY3,
        RECIPIENTS,
      );

      const aside = await second.setAsideStaleNoticesBefore(DAY2, DAY3, "stale", 10);
      expect(aside.map((box) => box.recipient)).not.toContain(AUDIT);
      const [closed] = await second.claimNoticesDue(DAY3, 10, seconds(60), [AUDIT]);
      expect(closed?.mailbox).toMatchObject({
        delivered: 1,
        headWrittenAt: DAY3.toISOString(),
        nextAttemptAt: DAY3,
      });
    },
  },
  {
    name: "a close behind an undelivered opened leaves the head at opened; after its ack the head is the close's time",
    run: async ({ first }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(pauseA());
      await first.markSentByTenantIdAndPauseId("default", "pause-a", RECIPIENTS);
      await first.cancelByTenantIdAndPauseId(
        "default",
        "pause-a",
        PauseResolution.Withdrawn,
        DAY3,
        RECIPIENTS,
      );

      const [claim] = await first.claimNoticesDue(DAY3, 10, seconds(60), [AUDIT]);

      expect(claim?.mailbox.headWrittenAt).toBe(pauseA().askedAt);
      if (claim === undefined) return;
      const next = await first.ackNotice(claim, DAY3);
      expect(next?.mailbox).toMatchObject({ delivered: 1, headWrittenAt: DAY3.toISOString() });
    },
  },
];
