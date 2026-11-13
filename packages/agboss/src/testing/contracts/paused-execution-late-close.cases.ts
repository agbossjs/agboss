import { expect } from "vitest";
import { PauseClosedReason } from "../../infrastructure/pause-record.js";
import {
  PauseResolution,
  type PausedExecutionRepository,
} from "../../infrastructure/paused-execution.repository.js";
import type { PauseAnswer } from "../../infrastructure/pause-record.js";
import type { ContractCase } from "./define.js";
import type { ContractInstances } from "./instance-context.js";
import {
  AFTER_DEADLINE,
  APPROVED_BY_MANAGER,
  CHANNEL_KEY,
  DECIDED_ANSWER,
  DEADLINE,
  expiringPauseOf,
  LISTENER_KEYS,
  MID,
  RECIPIENTS,
} from "./paused-execution-data.js";
import { noticesOf, peeker } from "./paused-execution-mailboxes.js";

/** #935: the `closed` a channel is told of a pause closed untaken never depends on when `markSent` runs. */
type Instances = ContractInstances<PausedExecutionRepository>;
type Store = PausedExecutionRepository;
const [AUDIT] = LISTENER_KEYS;
const LATER = new Date("2026-01-05T11:00:00.000Z");

/** The first close of a history: an expiry that decided, or a human answer. */
type FirstClose = (store: Store, pauseId: string) => Promise<unknown>;
const expiryDecided: FirstClose = (store, id) =>
  store.expireByTenantIdAndPauseId(
    "default",
    id,
    { answer: DECIDED_ANSWER },
    AFTER_DEADLINE,
    RECIPIENTS,
  );
const answered =
  (answer: PauseAnswer): FirstClose =>
  (store, id) =>
    store.resolveByTenantIdAndPauseId("default", id, answer, MID, RECIPIENTS);

/** `pause-a` is sent first, `pause-b` is told only at `markSent`: both closed untaken at `LATER`. */
async function bothHistories(
  { first, second }: Instances,
  close: FirstClose,
): Promise<readonly (readonly object[])[]> {
  await first.findOrCreateByStepKey(expiringPauseOf("pause-a", "run-1:s:1:a"));
  await first.findOrCreateByStepKey(expiringPauseOf("pause-b", "run-1:s:1:b"));
  await first.markSentByTenantIdAndPauseId("default", "pause-a", RECIPIENTS);
  for (const id of ["pause-a", "pause-b"]) {
    await close(first, id);
    await second.closeUntakenByTenantIdAndPauseId(
      "default",
      id,
      PauseResolution.TreeEnded,
      LATER,
      RECIPIENTS,
    );
  }
  await second.markSentByTenantIdAndPauseId("default", "pause-b", RECIPIENTS);
  const claims = await peeker(first)();
  const facts = (id: string, recipient: string): readonly object[] =>
    noticesOf(claims, id, recipient).map(({ kind, reason, closedAt, writtenAt }) => ({
      kind,
      reason,
      closedAt,
      writtenAt,
    }));
  return [
    facts("pause-a", CHANNEL_KEY),
    facts("pause-b", CHANNEL_KEY),
    facts("pause-a", AUDIT),
    facts("pause-b", AUDIT),
  ];
}

const untakenAt = {
  kind: "answer-not-taken",
  reason: PauseClosedReason.TreeEnded,
  closedAt: LATER.toISOString(),
  writtenAt: LATER.toISOString(),
};

export const LATE_CLOSE_CASES: readonly ContractCase<PausedExecutionRepository>[] = [
  {
    name: "#935 an expiry-decided pause closed untaken: the channel is told expired at the deadline, sent first or told at markSent",
    run: async (instances: Instances): Promise<void> => {
      const [sentFirst, lateSent, auditFirst, auditLate] = await bothHistories(
        instances,
        expiryDecided,
      );

      const closed = {
        kind: "closed",
        reason: PauseClosedReason.Expired,
        closedAt: DEADLINE.toISOString(),
        writtenAt: AFTER_DEADLINE.toISOString(),
      };
      expect(sentFirst?.slice(-2)).toMatchObject([closed, untakenAt]);
      expect(lateSent?.slice(-2)).toMatchObject([closed, untakenAt]);
      expect(lateSent).toEqual(sentFirst);
      expect(auditLate).toEqual(auditFirst);
    },
  },
  {
    name: "#935 a human answer closed untaken: the channel is told answered at the answer's time, sent first or told at markSent",
    run: async (instances: Instances): Promise<void> => {
      const [sentFirst, lateSent, auditFirst, auditLate] = await bothHistories(
        instances,
        answered(APPROVED_BY_MANAGER),
      );

      const closed = {
        kind: "closed",
        reason: PauseClosedReason.Answered,
        closedAt: MID.toISOString(),
        writtenAt: MID.toISOString(),
      };
      expect(sentFirst?.slice(-2)).toMatchObject([closed, untakenAt]);
      expect(lateSent).toEqual(sentFirst);
      expect(auditLate).toEqual(auditFirst);
    },
  },
  {
    name: "#935 closeUntaken keeps the first close on the record and a second one changes nothing",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(expiringPauseOf("pause-a"));
      await expiryDecided(first, "pause-a");

      const closed = await second.closeUntakenByTenantIdAndPauseId(
        "default",
        "pause-a",
        PauseResolution.Cancelled,
        LATER,
        RECIPIENTS,
      );
      const again = await first.closeUntakenByTenantIdAndPauseId(
        "default",
        "pause-a",
        PauseResolution.TreeEnded,
        LATER,
        RECIPIENTS,
      );

      expect(again).toBeUndefined();
      expect(closed).toMatchObject({
        resolution: PauseResolution.Cancelled,
        resolvedAt: LATER.toISOString(),
        closedFirst: {
          resolution: PauseResolution.DecidedOnExpiry,
          resolvedAt: AFTER_DEADLINE.toISOString(),
        },
      });
      expect(await first.findByTenantIdAndPauseId("default", "pause-a")).toEqual(closed);
    },
  },
];
