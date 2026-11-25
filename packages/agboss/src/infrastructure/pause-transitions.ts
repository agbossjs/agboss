import { decidedOnExpiryPause, expiredPause, untakenPause } from "./pause-closers.js";
import type { PlannedNotice } from "./pause-mailboxes.js";
import {
  PauseNoticeKind,
  type PauseDeadlineChange,
  type PauseNoticeFacts,
  type PauseRecipients,
} from "./pause-notices.js";
import {
  closedNotices,
  instantOf,
  noticesOf,
  openingNotices,
  untakenNotices,
} from "./pause-notice-plans.js";
import {
  cancelledPause,
  PauseResolution,
  PauseStatus,
  resolvedPause,
  type PauseAnswer,
  type PauseCancellation,
  type PauseExpiry,
  type PauseRecord,
  type PauseTrailRecord,
  type PauseUntakenResolution,
  PauseExpiryBound,
} from "./pause-record.js";
import { NEVER } from "./pause-scans.js";

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
  /** A pause the same transaction makes (#946: a reassignment's replacement), `Pending` and unsent. */
  readonly inserted?: PauseRecord;
}

/** What closing a pending pause does: its notice is written only when the pause is `isSent`. */
export const closing = (
  before: PauseRecord,
  after: PauseRecord,
  at: Date,
  recipients: PauseRecipients,
): PauseChange => ({
  pause: after,
  notices: before.isSent ? closedNotices(after, at, recipients) : [],
});

/** Whether a pending pause takes an answer at `at`: no deadline, or one after it (I2). */
export const isOpenAt = (pause: PauseRecord, at: Date): boolean =>
  pause.status === PauseStatus.Pending && (pause.expiresAt ?? NEVER) > at.toISOString();

/** Whether a pending pause's deadline is at or before `at`. */
export const isDueAt = (pause: PauseRecord, at: Date): boolean =>
  pause.status === PauseStatus.Pending && (pause.expiresAt ?? NEVER) <= at.toISOString();

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

/**
 * A pending pause's deadline moved, never to a past time (I3), never earlier or equal (#1099), and
 * only from the deadline the caller read: whoever read an older one lost to a writer that moved it.
 */
export function extendChange(
  pause: PauseRecord,
  extension: PauseDeadlineChange,
  at: Date,
  recipients: PauseRecipients,
): PauseChange | undefined {
  // a pause with no deadline gets none, and one that is not open takes no extension (I3)
  if (
    !isOpenAt(pause, at) ||
    // Stryker disable next-line ConditionalExpression: the floors below hold a time of the pause's own, and no extension is after `undefined`, so a pause with no deadline is refused there too
    pause.expiresAt === undefined
  )
    return undefined;
  // from the deadline the caller read, to a time after it and after `at`: never to a past time (I3), never
  // earlier or equal (#1099) — one comparison against both floors
  const floors = [pause.expiresAt, at.toISOString()];
  if (
    pause.expiresAt !== extension.previousExpiresAt ||
    !floors.every((floor) => extension.expiresAt > floor)
  )
    return undefined;
  const changes = pause.trail.filter((entry) => entry.action === "timeout-changed").length;
  if (extension.maxExtensions !== undefined && changes >= extension.maxExtensions) return undefined;
  return {
    pause: {
      ...pause,
      expiresAt: extension.expiresAt,
      expiryBound: PauseExpiryBound.Pause,
      remindAt: extension.remindAt,
      trail: [...pause.trail, timeoutChangedEntryOf(pause, extension, at)],
    },
    notices: noticesOf(recipients, PauseNoticeKind.Extended, at, {
      expiresAt: extension.expiresAt,
      previousExpiresAt: pause.expiresAt,
    }),
  };
}

/** The entry a deadline change adds to the chain of custody: who moved it, when, to what. */
function timeoutChangedEntryOf(
  pause: PauseRecord,
  extension: PauseDeadlineChange,
  at: Date,
): PauseTrailRecord {
  return {
    action: "timeout-changed",
    at: at.toISOString(),
    ...(extension.actor === undefined ? {} : { actor: extension.actor }),
    target: pause.target,
    ...(pause.channel === undefined ? {} : { channel: pause.channel }),
    ...(pause.assignees === undefined ? {} : { assignees: pause.assignees }),
    expiresAt: extension.expiresAt,
    ...(pause.externalRef === undefined ? {} : { externalRef: pause.externalRef }),
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

/** The reference the channel's system gave the pause: on the record and on its newest entry of the chain of custody. */
function withExternalRef(
  pause: PauseRecord,
  externalRef: string | undefined,
): Partial<Pick<PauseRecord, "externalRef" | "trail">> {
  if (externalRef === undefined) return {};
  const last = pause.trail.at(-1);
  return {
    externalRef,
    trail: [...pause.trail.slice(0, -1), ...(last === undefined ? [] : [{ ...last, externalRef }])],
  };
}

/**
 * The channel was asked (rule 2): `isSent` whatever the status, and — only when it was not yet —
 * `opened` to the listeners, then, when the pause closed meanwhile, its `closed` to the channel and
 * the listeners, then its `answerNotTaken` when its answer was closed untaken (I8). The notices
 * carry the times the record knows (`askedAt`, `resolvedAt` / `expiresAt`), so `markSent`, which
 * has no `at`, reads no clock of its own.
 */
export function markSentChange(
  pause: PauseRecord,
  recipients: PauseRecipients,
  externalRef?: string,
): PauseChange {
  if (pause.isSent) return { pause, notices: [] };
  const sent = { ...pause, isSent: true, ...withExternalRef(pause, externalRef) };
  const opened = openingNotices(pause, sent, recipients);
  if (pause.status === PauseStatus.Pending) return { pause: sent, notices: opened };
  const first = pause.closedFirst ?? pause;
  const closedAt = instantOf(first.resolvedAt ?? pause.askedAt);
  const untaken =
    pause.answer !== undefined &&
    (pause.resolution === PauseResolution.Cancelled ||
      pause.resolution === PauseResolution.TreeEnded)
      ? untakenNotices(pause.resolution, instantOf(pause.resolvedAt), recipients)
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
