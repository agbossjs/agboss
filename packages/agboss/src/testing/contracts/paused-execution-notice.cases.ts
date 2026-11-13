import { expect } from "vitest";
import { PauseClosedReason } from "../../infrastructure/pause-record.js";
import { NO_RECIPIENTS } from "../../infrastructure/pause-notices.js";
import {
  PauseResolution,
  type PausedExecutionRepository,
} from "../../infrastructure/paused-execution.repository.js";
import type { ContractCase } from "./define.js";
import type { ContractInstances } from "./instance-context.js";
import {
  AFTER_DEADLINE,
  APPROVED_BY_MANAGER,
  BEFORE_DEADLINE,
  CHANNEL_KEY,
  DECIDED_ANSWER,
  expiringPauseOf,
  LISTENER_KEYS,
  NINE,
  RECIPIENTS,
  MID,
} from "./paused-execution-data.js";
import { kindsOf, noticesOf, peeker } from "./paused-execution-mailboxes.js";

/** #910 AC2, I7, I8: a notice is written with its change, to the receivers of its kind, in order. */
type Instances = ContractInstances<PausedExecutionRepository>;
const [AUDIT, SLACK] = LISTENER_KEYS;

/** A sent pause `pause-a` with a deadline. */
async function sentPause(store: PausedExecutionRepository, id = "pause-a"): Promise<void> {
  await store.findOrCreateByStepKey(expiringPauseOf(id, `run-1:s:1:${id}`));
  await store.markSentByTenantIdAndPauseId("default", id, RECIPIENTS);
}

export const NOTICE_WRITE_CASES: readonly ContractCase<PausedExecutionRepository>[] = [
  {
    name: "markSent writes opened to listeners only, with the deadline; a second markSent writes nothing",
    run: async ({ first, second }: Instances): Promise<void> => {
      await sentPause(first);
      await second.markSentByTenantIdAndPauseId("default", "pause-a", RECIPIENTS);

      const claims = await peeker(second)();

      expect(kindsOf(claims, "pause-a", CHANNEL_KEY)).toEqual([]);
      for (const key of LISTENER_KEYS) expect(kindsOf(claims, "pause-a", key)).toEqual(["opened"]);
      expect(noticesOf(claims, "pause-a", AUDIT)[0]).toMatchObject({
        seq: 1,
        expiresAt: expiringPauseOf("x").expiresAt,
      });
    },
  },
  {
    name: "a close of a sent pause writes closed to channel and listeners",
    run: async ({ first, second }: Instances): Promise<void> => {
      await sentPause(first);

      await second.resolveByTenantIdAndPauseId(
        "default",
        "pause-a",
        APPROVED_BY_MANAGER,
        MID,
        RECIPIENTS,
      );

      const claims = await peeker(first)();
      expect(kindsOf(claims, "pause-a", CHANNEL_KEY)).toEqual(["closed"]);
      expect(kindsOf(claims, "pause-a", SLACK)).toEqual(["opened", "closed"]);
      expect(noticesOf(claims, "pause-a", CHANNEL_KEY)[0]).toMatchObject({
        reason: PauseClosedReason.Answered,
        closedAt: MID.toISOString(),
      });
    },
  },
  {
    name: "a close of an unsent pause writes nothing; its markSent then writes opened then closed (the reason of that close), V8: to the channel and each listener",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(expiringPauseOf("pause-a"));
      await first.cancelByTenantIdAndPauseId(
        "default",
        "pause-a",
        PauseResolution.Withdrawn,
        MID,
        RECIPIENTS,
      );
      expect(await peeker(first)()).toEqual([]);

      const stillPending = await second.markSentByTenantIdAndPauseId(
        "default",
        "pause-a",
        RECIPIENTS,
      );

      const claims = await peeker(first)();
      expect(stillPending).toBe(false);
      expect(kindsOf(claims, "pause-a", CHANNEL_KEY)).toEqual(["closed"]);
      for (const key of LISTENER_KEYS)
        expect(kindsOf(claims, "pause-a", key)).toEqual(["opened", "closed"]);
      expect(noticesOf(claims, "pause-a", CHANNEL_KEY)[0]?.reason).toBe(
        PauseClosedReason.Withdrawn,
      );
    },
  },
  {
    name: "a pause its channel decided at once gets no notice",
    run: async ({ first }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(expiringPauseOf("pause-a"));
      await first.decideByTenantIdAndPauseId("default", "pause-a", DECIDED_ANSWER, MID);

      expect(await peeker(first)()).toEqual([]);
    },
  },
  {
    name: "a compare-and-set that does not apply writes no notice",
    run: async ({ first, second }: Instances): Promise<void> => {
      await sentPause(first);
      const before = await first.countNotices();

      await second.resolveByTenantIdAndPauseId(
        "default",
        "pause-a",
        APPROVED_BY_MANAGER,
        AFTER_DEADLINE,
        RECIPIENTS,
      );
      await second.extendByTenantIdAndPauseId(
        "default",
        "pause-a",
        { expiresAt: NINE.toISOString() },
        MID,
        RECIPIENTS,
      );
      await second.expireByTenantIdAndPauseId(
        "default",
        "pause-a",
        {},
        BEFORE_DEADLINE,
        RECIPIENTS,
      );
      await second.closeUntakenByTenantIdAndPauseId(
        "default",
        "pause-a",
        PauseResolution.Cancelled,
        MID,
        RECIPIENTS,
      );

      const claims = await peeker(first)();
      expect(await first.countNotices()).toEqual(before);
      for (const key of LISTENER_KEYS) expect(kindsOf(claims, "pause-a", key)).toEqual(["opened"]);
      expect(kindsOf(claims, "pause-a", CHANNEL_KEY)).toEqual([]);
    },
  },
  {
    name: "two instances close concurrently: one closed notice per recipient",
    run: async ({ first, second }: Instances): Promise<void> => {
      await sentPause(first);

      await Promise.all([
        first.cancelByTenantIdAndPauseId(
          "default",
          "pause-a",
          PauseResolution.Cancelled,
          BEFORE_DEADLINE,
          RECIPIENTS,
        ),
        second.cancelByTenantIdAndPauseId(
          "default",
          "pause-a",
          PauseResolution.Withdrawn,
          BEFORE_DEADLINE,
          RECIPIENTS,
        ),
      ]);

      const claims = await peeker(first)();
      expect(kindsOf(claims, "pause-a", CHANNEL_KEY)).toEqual(["closed"]);
      for (const key of LISTENER_KEYS)
        expect(kindsOf(claims, "pause-a", key)).toEqual(["opened", "closed"]);
    },
  },
  {
    name: "a close with no recipients writes no notice",
    run: async ({ first }: Instances): Promise<void> => {
      await sentPause(first);
      await first.cancelByTenantIdAndPauseId(
        "default",
        "pause-a",
        PauseResolution.Cancelled,
        MID,
        NO_RECIPIENTS,
      );

      const claims = await peeker(first)();
      for (const key of LISTENER_KEYS) expect(kindsOf(claims, "pause-a", key)).toEqual(["opened"]);
    },
  },
];
