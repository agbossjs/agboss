import { closedAtOf, closedReasonOf } from "./pause-closing.js";
import { decidedOnExpiryPause, expiredPause, untakenPause } from "./pause-closers.js";
import type { PlannedNotice } from "./pause-mailboxes.js";
import {
  PauseNoticeKind,
  recipientKeysOf,
  type PauseExtension,
  type PauseNoticeFacts,
  type PauseRecipients,
} from "./pause-notices.js";
import {
  cancelledPause,
  PauseResolution,
  PauseStatus,
  resolvedPause,
  type PauseAnswer,
  type PauseCancellation,
  type PauseExpiry,
  type PauseRecord,
  type PauseUntakenResolution,
  PauseClosedReason,
  PauseExpiryBound,
} from "./pause-record.js";

/**
 * Every transition of a pause as a pure function (#935, #910 rules 1–8): the record a change makes
 * and the notices it writes with it, or `undefined` when its condition does not hold. The core's
 * stores apply the answer atomically — the in-memory store in one step, SQLite in one `BEGIN
 * IMMEDIATE` — so no store can read a condition differently, and a change that does not apply
 * writes nothing. Times are ISO 8601 text on the application's `Clock`: they compare as time.
 */

/** A change of a pause with the notices that go in the same transaction. */
export interface PauseChange {
  readonly pause: PauseRecord;
  readonly notices: readonly PlannedNotice[];
}

/** The notice of `kind` to each receiver of it, due at `at`. */
function noticesOf(
  recipients: PauseRecipients,
  kind: PauseNoticeKind,
  at: Date,
  facts: PauseNoticeFacts,
): readonly PlannedNotice[] {
  const notice = { kind, writtenAt: at.toISOString(), ...facts };
  return recipientKeysOf(recipients, kind).map((recipient) => ({ recipient, at, notice }));
}

/** The `closed` notice of a record that closed. */
const closedNotices = (
  closed: PauseRecord,
  at: Date,
  recipients: PauseRecipients,
): readonly PlannedNotice[] =>
  noticesOf(recipients, PauseNoticeKind.Closed, at, {
    reason: closedReasonOf(closed),
    ...(closedAtOf(closed) === undefined ? {} : { closedAt: closedAtOf(closed) }),
  });

/** What closing a pending pause does: its notice is written only when the pause is `isSent`. */
const closing = (
  before: PauseRecord,
  after: PauseRecord,
  at: Date,
  recipients: PauseRecipients,
): PauseChange => ({
  pause: after,
  notices: before.isSent ? closedNotices(after, at, recipients) : [],
});

/** Whether a pending pause takes an answer at `at`: no deadline, or one after it (I2). */
const isOpenAt = (pause: PauseRecord, at: Date): boolean =>
  pause.status === PauseStatus.Pending &&
  (pause.expiresAt === undefined || pause.expiresAt > at.toISOString());

/** Whether a pending pause's deadline is at or before `at`. */
const isDueAt = (pause: PauseRecord, at: Date): boolean =>
  pause.status === PauseStatus.Pending &&
  pause.expiresAt !== undefined &&
  pause.expiresAt <= at.toISOString();

/** `Pending → Resolved` with the answer, only while `expiresAt` is after `at` (I1, I2). */
export function resolveChange(
  pause: PauseRecord,
  answer: PauseAnswer,
  at: Date,
  recipients: PauseRecipients,
): PauseChange | undefined {
  return isOpenAt(pause, at)
    ? closing(pause, resolvedPause(pause, answer, at), at, recipients)
    : undefined;
}

/** `Pending → Cancelled`; a cancel or a tree end at or after `expiresAt` records `Expired` (I3). */
export function cancelChange(
  pause: PauseRecord,
  resolution: PauseCancellation,
  at: Date,
  recipients: PauseRecipients,
): PauseChange | undefined {
  if (pause.status !== PauseStatus.Pending) return undefined;
  const isExpired = resolution !== PauseResolution.Withdrawn && isDueAt(pause, at);
  const closed = isExpired
    ? expiredPause(pause, at, undefined)
    : cancelledPause(pause, resolution, at);
  return closing(pause, closed, at, recipients);
}

/** An expiry at or after `expiresAt`: the channel's answer, else `Cancelled / Expired`. */
export function expireChange(
  pause: PauseRecord,
  expiry: PauseExpiry,
  at: Date,
  recipients: PauseRecipients,
): PauseChange | undefined {
  if (!isDueAt(pause, at)) return undefined;
  const closed =
    expiry.answer === undefined
      ? expiredPause(pause, at, expiry.problem)
      : decidedOnExpiryPause(pause, expiry.answer, at);
  return closing(pause, closed, at, recipients);
}

/** `Resolved → Cancelled`, the answer kept: its run never applied it (Q2). */
export function closeUntakenChange(
  pause: PauseRecord,
  resolution: PauseUntakenResolution,
  at: Date,
  recipients: PauseRecipients,
): PauseChange | undefined {
  if (pause.status !== PauseStatus.Resolved) return undefined;
  return {
    pause: untakenPause(pause, resolution, at),
    notices: pause.isSent ? untakenNotices(resolution, at, recipients) : [],
  };
}

/** The `answerNotTaken` notice: why it closed and when. */
const untakenNotices = (
  resolution: PauseUntakenResolution,
  at: Date,
  recipients: PauseRecipients,
): readonly PlannedNotice[] =>
  noticesOf(recipients, PauseNoticeKind.AnswerNotTaken, at, {
    reason:
      resolution === PauseResolution.Cancelled
        ? PauseClosedReason.Cancelled
        : PauseClosedReason.TreeEnded,
    closedAt: at.toISOString(),
  });

/** A pending pause's deadline moved, never to a past time (I3). */
export function extendChange(
  pause: PauseRecord,
  extension: PauseExtension,
  at: Date,
  recipients: PauseRecipients,
): PauseChange | undefined {
  const now = at.toISOString();
  if (!isOpenAt(pause, at) || pause.expiresAt === undefined || extension.expiresAt <= now)
    return undefined;
  return {
    pause: {
      ...pause,
      expiresAt: extension.expiresAt,
      expiryBound: PauseExpiryBound.Pause,
      remindAt: extension.remindAt,
    },
    notices: noticesOf(recipients, PauseNoticeKind.Extended, at, {
      expiresAt: extension.expiresAt,
      previousExpiresAt: pause.expiresAt,
    }),
  };
}

/** The reminder of a pending pause, once: `remindAt ≤ at < expiresAt`. */
export function remindChange(
  pause: PauseRecord,
  at: Date,
  recipients: PauseRecipients,
): PauseChange | undefined {
  if (!isOpenAt(pause, at) || pause.expiresAt === undefined) return undefined;
  if (pause.remindAt === undefined || pause.remindAt > at.toISOString()) return undefined;
  return {
    pause: { ...pause, remindAt: undefined },
    notices: noticesOf(recipients, PauseNoticeKind.Expiring, at, { expiresAt: pause.expiresAt }),
  };
}

/** The instant of a record's time text; a record stored before `askedAt` (empty) is the epoch. */
function instantOf(text: string | undefined): Date {
  const instant = new Date(text ?? "");
  return Number.isNaN(instant.getTime()) ? new Date(0) : instant;
}

/**
 * The channel was asked (rule 2): `isSent` whatever the status, and — only when it was not yet —
 * `opened` to the listeners, then, when the pause closed meanwhile, its `closed` to the channel and
 * the listeners, then its `answerNotTaken` when its answer was closed untaken (I8). The notices
 * carry the times the record knows (`askedAt`, `resolvedAt` / `expiresAt`), so `markSent`, which
 * has no `at`, reads no clock of its own.
 */
export function markSentChange(pause: PauseRecord, recipients: PauseRecipients): PauseChange {
  if (pause.isSent) return { pause, notices: [] };
  const sent = { ...pause, isSent: true };
  const opened = noticesOf(
    recipients,
    PauseNoticeKind.Opened,
    instantOf(pause.askedAt),
    pause.expiresAt === undefined ? {} : { expiresAt: pause.expiresAt },
  );
  if (pause.status === PauseStatus.Pending) return { pause: sent, notices: opened };
  const closedAt = instantOf(closedAtOf(pause) ?? pause.askedAt);
  const untaken =
    pause.answer !== undefined &&
    (pause.resolution === PauseResolution.Cancelled ||
      pause.resolution === PauseResolution.TreeEnded)
      ? untakenNotices(pause.resolution, closedAt, recipients)
      : [];
  return {
    pause: sent,
    notices: [...opened, ...closedNotices(pause, closedAt, recipients), ...untaken],
  };
}

/** A notice of `kind` for a pause in any status, once the pause is sent (`noticeOnce…`). */
export function onceNotices(
  pause: PauseRecord,
  kind: PauseNoticeKind,
  facts: PauseNoticeFacts,
  at: Date,
  recipients: PauseRecipients,
): readonly PlannedNotice[] {
  return pause.isSent ? noticesOf(recipients, kind, at, facts) : [];
}
