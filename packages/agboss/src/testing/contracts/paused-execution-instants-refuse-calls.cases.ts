import { expect } from "vitest";
import { PauseNoticeKind } from "../../infrastructure/pause-notices.js";
import { PauseResolution } from "../../infrastructure/pause-record.js";
import { seenOf } from "../../infrastructure/pause-seen.js";
import { seconds } from "../../units/index.js";
import {
  ALL_KEYS,
  APPROVED_BY_MANAGER,
  DECIDED_ANSWER,
  NINE,
  RECIPIENTS,
} from "./paused-execution-data.js";
import {
  preciseOf,
  stored,
  T,
  type Case,
  type Instances,
} from "./paused-execution-instants-data.js";
import { expectRefused, INVALID, refusalOf } from "./paused-execution-instants-refuse.cases.js";

/**
 * #1307 (G3), the rest of the entry points: every transition and every mailbox operation refuses an
 * Invalid Date with `StoreError.UnreadableRecord` before it writes anything. A store that plans one in its
 * own SQL (`WHERE expires_at <= $at`) instead of through the exported rules fails here.
 */
type Calls = Record<string, () => Promise<unknown>>;
const CLOSED = PauseResolution.Cancelled;

/** A sent pause `pause-a`, and `pause-b` sent and answered (its answer is not taken yet). */
async function sentPauses({ first: one }: Instances): Promise<void> {
  await one.findOrCreateByStepKey(preciseOf("pause-a"));
  await one.markSentByTenantIdAndPauseId("default", "pause-a", RECIPIENTS);
  await one.findOrCreateByStepKey(preciseOf("pause-b", "run-1:clerk-agent:2:call-2"));
  await one.markSentByTenantIdAndPauseId("default", "pause-b", RECIPIENTS);
  await one.resolveByTenantIdAndPauseId(
    "default",
    "pause-b",
    APPROVED_BY_MANAGER,
    NINE,
    RECIPIENTS,
  );
}

const transitionCalls = ({ second }: Instances, seen: ReturnType<typeof seenOf>): Calls => ({
  decide: () =>
    second.decideByTenantIdAndPauseId("default", "pause-a", DECIDED_ANSWER, INVALID(), seen),
  cancel: () =>
    second.cancelByTenantIdAndPauseId("default", "pause-a", CLOSED, INVALID(), RECIPIENTS),
  expire: () => second.expireByTenantIdAndPauseId("default", "pause-a", {}, INVALID(), RECIPIENTS),
  "close untaken": () =>
    second.closeUntakenByTenantIdAndPauseId("default", "pause-b", CLOSED, INVALID(), RECIPIENTS),
  remind: () => second.remindByTenantIdAndPauseId("default", "pause-a", INVALID(), RECIPIENTS),
});

const reassignCalls = ({ second }: Instances, seen: ReturnType<typeof seenOf>): Calls => {
  const reassign = (change: object, at: Date): Promise<unknown> =>
    second.reassignByTenantIdAndPauseId("default", "pause-a", { seen, ...change }, at, RECIPIENTS);
  return {
    "reassign at": () => reassign({ assignees: ["x"] }, INVALID()),
    "reassign due.expiresAt": () => reassign({ due: { expiresAt: INVALID() } }, NINE),
    "reassign timeout.expiresAt": () => reassign({ timeout: { expiresAt: INVALID() } }, NINE),
  };
};

const noticeCalls = ({ second }: Instances): Calls => {
  const once = (facts: object, at: Date): Promise<unknown> =>
    second.noticeOnceByTenantIdAndPauseId(
      "default",
      "pause-a",
      PauseNoticeKind.Expiring,
      facts,
      at,
      RECIPIENTS,
    );
  return {
    "noticeOnce at": () => once({}, INVALID()),
    "noticeOnce expiresAt": () => once({ expiresAt: INVALID() }, NINE),
  };
};

export const INSTANT_REFUSAL_CALL_CASES: readonly Case[] = [
  {
    name: "#1307: decide, cancel, expire, close-untaken, remind, reassign and noticeOnce with an Invalid Date are refused with StoreError.UnreadableRecord, and the pause and its mailboxes are as they were",
    run: async (instances: Instances): Promise<void> => {
      const { first: one, second } = instances;
      await sentPauses(instances);
      const seen = seenOf(await stored(second, "pause-a"));
      const before = [await stored(one, "pause-a"), await stored(one, "pause-b")];
      const counts = await one.countNotices();
      const calls = {
        ...transitionCalls(instances, seen),
        ...reassignCalls(instances, seen),
        ...noticeCalls(instances),
      };

      for (const [name, call] of Object.entries(calls)) expectRefused(await refusalOf(call), name);

      expect([await stored(one, "pause-a"), await stored(one, "pause-b")]).toEqual(before);
      expect(await one.countNotices()).toEqual(counts);
    },
  },
  {
    name: "#1307: a mailbox claim, acknowledgement, renewal, retry and stale set-aside at an Invalid Date are refused with StoreError.UnreadableRecord and change nothing",
    run: async ({ first: one }: Instances): Promise<void> => {
      await one.findOrCreateByStepKey(preciseOf("pause-a"));
      await one.markSentByTenantIdAndPauseId("default", "pause-a", RECIPIENTS);
      await one.resolveByTenantIdAndPauseId(
        "default",
        "pause-a",
        APPROVED_BY_MANAGER,
        NINE,
        RECIPIENTS,
      );
      const [claim] = await one.claimNoticesDue(T(0), 1, seconds(60), ALL_KEYS);
      if (claim === undefined) return expect.fail("a mailbox is due");
      const counts = await one.countNotices();
      const calls: Calls = {
        claim: () => one.claimNoticesDue(INVALID(), 10, seconds(60), ALL_KEYS),
        ack: () => one.ackNotice(claim, INVALID()),
        renew: () => one.renewNotice(claim, INVALID(), seconds(60)),
        retry: () => one.retryNotice(claim, INVALID(), "receiver.timeout"),
        "stale before": () => one.setAsideStaleNoticesBefore(INVALID(), T(0), "stale", 10),
        "stale at": () => one.setAsideStaleNoticesBefore(T(0), INVALID(), "stale", 10),
      };

      for (const [name, call] of Object.entries(calls)) expectRefused(await refusalOf(call), name);

      expect(await one.countNotices()).toEqual(counts);
      // the claim is still its own: a valid retry takes it
      expect(await one.retryNotice(claim, T(1), "receiver.timeout")).toBe(true);
    },
  },
];
