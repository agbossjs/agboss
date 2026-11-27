import { expect } from "vitest";
import { seconds } from "../../units/index.js";
import { PauseNoticeKind, type PauseNoticeClaim } from "../../infrastructure/pause-notices.js";
import { PauseStatus } from "../../infrastructure/pause-record.js";
import { seenOf } from "../../infrastructure/pause-seen.js";
import { APPROVED_BY_MANAGER, NINE, RECIPIENTS } from "./paused-execution-data.js";
import {
  asked,
  deadline,
  expectInstant,
  moveDatesOf,
  preciseOf,
  R,
  sameAs,
  stored,
  T,
  type Case,
  type Instances,
} from "./paused-execution-instants-data.js";
import { FAR, noticesOf, peeker } from "./paused-execution-mailboxes.js";

/** Moves every `Date` of a claim: the lease and the due time far ahead (a store that shares them holds the mailbox claimed, and not due, from now on), the rest to the epoch. */
const moveClaim = (claim: PauseNoticeClaim): void => {
  claim.until.setTime(FAR * 2);
  claim.mailbox.nextAttemptAt.setTime(FAR * 2);
  claim.mailbox.headWrittenAt?.setTime(0);
  for (const notice of claim.mailbox.notices)
    for (const at of [
      notice.writtenAt,
      notice.expiresAt,
      notice.closedAt,
      notice.previousExpiresAt,
    ])
      at?.setTime(0);
};

/**
 * #1307 (G3): what a store hands back from a transition, and the notices it hands to a claim, are the
 * caller's own `Date`s: a `setTime` on them, or on the instance the caller gave, moves nothing the
 * store holds. A store that caches documents and returns them by reference fails these.
 */
export const INSTANT_COPY_CASES: readonly Case[] = [
  {
    name: "#1307: the record a transition returns carries the caller's own Dates: moving them moves nothing the store holds",
    run: async ({ first: one, second }: Instances): Promise<void> => {
      await one.findOrCreateByStepKey(preciseOf("pause-a"));
      const read = await stored(second, "pause-a");
      const changed = await second.changeTimeoutByTenantIdAndPauseId(
        "default",
        "pause-a",
        { expiresAt: T(130), previousExpiresAt: sameAs(deadline()), seen: seenOf(read) },
        sameAs(NINE),
        R,
      );
      moveDatesOf(changed);

      const again = await stored(one, "pause-a");
      expectInstant(again.expiresAt, T(130), "expiresAt");
      expectInstant(again.askedAt, asked(), "askedAt");
      expectInstant(again.trail[0]?.at, asked(), "trail[0].at");
      expectInstant(again.trail[1]?.at, NINE, "trail[1].at");

      const answered = await second.resolveByTenantIdAndPauseId(
        "default",
        "pause-a",
        APPROVED_BY_MANAGER,
        sameAs(NINE),
        R,
      );
      moveDatesOf(answered);
      const resolved = await stored(one, "pause-a");
      expectInstant(resolved.resolvedAt, NINE, "resolvedAt");
      expectInstant(resolved.askedAt, asked(), "askedAt after the answer");
    },
  },
  {
    name: "#1307: the found pause of findOrCreateByStepKey and the listings of a tree carry the caller's own Dates",
    run: async ({ first: one, second }: Instances): Promise<void> => {
      await one.findOrCreateByStepKey(preciseOf("pause-a"));

      const found = await second.findOrCreateByStepKey(preciseOf("pause-a"));
      moveDatesOf(found);
      const byKey = await second.findByTenantIdAndRootExecutionIdAndStepKey(
        "default",
        found.rootExecutionId,
        found.stepKey,
      );
      moveDatesOf(byKey);
      const listed = await second.findAllByTenantIdAndRootExecutionId(
        "default",
        found.rootExecutionId,
      );
      for (const pause of listed) moveDatesOf(pause);

      const again = await stored(one, "pause-a");
      expectInstant(again.expiresAt, deadline(), "expiresAt");
      expectInstant(again.askedAt, asked(), "askedAt");
      expectInstant(again.trail[0]?.at, asked(), "trail[0].at");
    },
  },
  {
    name: "#1307: the Dates a transition was given are copied: moving them after the call moves nothing the store holds",
    run: async ({ first: one, second }: Instances): Promise<void> => {
      await one.findOrCreateByStepKey(preciseOf("pause-a"));
      const read = await stored(second, "pause-a");
      const at = new Date(NINE.getTime());
      const expiresAt = T(130);
      const previousExpiresAt = sameAs(deadline());
      await second.changeTimeoutByTenantIdAndPauseId(
        "default",
        "pause-a",
        { expiresAt, previousExpiresAt, seen: seenOf(read) },
        at,
        RECIPIENTS,
      );

      at.setTime(0);
      expiresAt.setTime(0);
      previousExpiresAt.setTime(0);

      const again = await stored(one, "pause-a");
      expect(again.status).toBe(PauseStatus.Pending);
      expectInstant(again.expiresAt, T(130), "expiresAt");
      expectInstant(again.trail[1]?.at, NINE, "trail[1].at");
      expectInstant(again.trail[1]?.expiresAt, T(130), "trail[1].expiresAt");
      const claims = await peeker(second)();
      const timeoutChanged = noticesOf(claims, "pause-a", "listener:slack-listener").find(
        (notice) => notice.kind === PauseNoticeKind.TimeoutChanged,
      );
      expectInstant(timeoutChanged?.writtenAt, NINE, "the notice's writtenAt");
      expectInstant(timeoutChanged?.expiresAt, T(130), "the notice's expiresAt");
    },
  },
  {
    name: "#1307: the notices and the claim a store hands out carry the caller's own Dates: moving them moves nothing the store holds",
    run: async ({ first: one, second }: Instances): Promise<void> => {
      await one.findOrCreateByStepKey(preciseOf("pause-a"));
      await second.markSentByTenantIdAndPauseId("default", "pause-a", RECIPIENTS);
      await one.resolveByTenantIdAndPauseId(
        "default",
        "pause-a",
        APPROVED_BY_MANAGER,
        NINE,
        RECIPIENTS,
      );
      const peek = peeker(second);

      for (const claim of await peek()) moveClaim(claim);

      const claims = await peek();
      const [opened, closed] = noticesOf(claims, "pause-a", "listener:slack-listener");
      expectInstant(opened?.writtenAt, asked(), "opened: writtenAt");
      expectInstant(opened?.expiresAt, deadline(), "opened: expiresAt");
      expectInstant(closed?.writtenAt, NINE, "closed: writtenAt");
      expectInstant(closed?.closedAt, NINE, "closed: closedAt");
      const box = claims.find((claim) => claim.mailbox.recipient === "listener:slack-listener");
      expectInstant(box?.mailbox.headWrittenAt, asked(), "mailbox: headWrittenAt");
    },
  },
  {
    name: "#1307: the claim a renewal returns and the due time a retry was given are copied: moving them moves neither the lease nor the due time",
    run: async ({ first: one, second }: Instances): Promise<void> => {
      await one.findOrCreateByStepKey(preciseOf("pause-a"));
      await second.markSentByTenantIdAndPauseId("default", "pause-a", RECIPIENTS);
      const listener = ["listener:slack-listener"];
      const at = (ms: number): Date => new Date(FAR + ms);
      const [claim] = await second.claimNoticesDue(at(0), 10, seconds(60), listener);
      if (claim === undefined) return expect.fail("the opened notice is due");

      const renewed = await second.renewNotice(claim, at(1000), seconds(60));
      renewed?.until.setTime(at(86_400_000).getTime());

      // the lease ends at its own time, whatever was done to the instance the caller was given
      const [again] = await second.claimNoticesDue(at(120_000), 10, seconds(60), listener);
      if (again === undefined) return expect.fail("the lease lapsed at its own time");
      const nextAttemptAt = at(600_000);
      expect(await second.retryNotice(again, nextAttemptAt, "receiver.timeout")).toBe(true);
      nextAttemptAt.setTime(0);

      expect(await second.claimNoticesDue(at(130_000), 10, seconds(60), listener)).toHaveLength(0);
      expect(await second.claimNoticesDue(at(700_000), 10, seconds(60), listener)).toHaveLength(1);
    },
  },
  {
    name: "#1307: the time an acknowledgement was given is copied: moving it afterwards moves nothing the next notice is due at",
    run: async ({ first: one, second }: Instances): Promise<void> => {
      await one.findOrCreateByStepKey(preciseOf("pause-a"));
      await second.markSentByTenantIdAndPauseId("default", "pause-a", RECIPIENTS);
      await one.resolveByTenantIdAndPauseId(
        "default",
        "pause-a",
        APPROVED_BY_MANAGER,
        sameAs(NINE),
        RECIPIENTS,
      );
      const listener = ["listener:slack-listener"];
      const at = (ms: number): Date => new Date(FAR + ms);
      const [claim] = await second.claimNoticesDue(at(0), 10, seconds(1), listener);
      if (claim === undefined) return expect.fail("the opened notice is due");

      // the next notice (closed) is due at the time of the acknowledgement
      const acknowledgedAt = at(500);
      expect(await second.ackNotice(claim, acknowledgedAt)).toBeDefined();
      acknowledgedAt.setTime(at(86_400_000).getTime());

      const [next] = await second.claimNoticesDue(at(2000), 10, seconds(1), listener);
      expect(next?.mailbox.notices.map((notice) => notice.kind)).toContain(PauseNoticeKind.Closed);
    },
  },
];
