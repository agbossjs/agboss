import { decidedOnExpiryPause, expiredPause, untakenPause } from "./pause-closers.js";
import type { PlannedNotice } from "./pause-mailboxes.js";
import {
  PauseNoticeKind,
  type PauseNoticeFacts,
  type PauseRecipients,
  type PauseSeen,
} from "./pause-notices.js";
import { isSeenAs } from "./pause-seen.js";
import {
  closedNotices,
  inFirstSendNotices,
  noticesOf,
  openingNotices,
  untakenNotices,
} from "./pause-notice-plans.js";
import {
  cancelledPause,
  decidedPause,
  PauseResolution,
  PauseStatus,
  resolvedPause,
  type PauseAnswer,
  type PauseCancellation,
  type PauseExpiry,
  type PauseRecord,
  type PauseUntakenResolution,
} from "./pause-record.js";
import { isAtOrBefore, isBefore } from "./instants.js";

/**
 * Every transition of a pause as a pure function (#935, #910 rules 1–8): the record a change makes
 * and the notices it writes with it, or `undefined` when its condition does not hold. The core's
 * stores apply the answer atomically — the in-memory store in one step, SQLite in one `BEGIN
 * IMMEDIATE` — so no store can read a condition differently, and a change that does not apply
 * writes nothing. Times are `Date`s on the application's `Clock`, compared by instant (`instants.ts`), never with `===`.
 */

/** A change of a pause with the notices that go in the same transaction. */
export interface PauseTransition {
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
): PauseTransition => ({
  pause: after,
  notices: before.isSent ? closedNotices(after, at, recipients) : [],
});

/** Whether a pending pause takes an answer at `at`: no deadline, or one after it (I2). */
export const isOpenAt = (pause: PauseRecord, at: Date): boolean =>
  pause.status === PauseStatus.Pending &&
  (pause.expiresAt === undefined || isBefore(at, pause.expiresAt));

/** Whether a pending pause's deadline is at or before `at`. */
export const isDueAt = (pause: PauseRecord, at: Date): boolean =>
  pause.status === PauseStatus.Pending &&
  pause.expiresAt !== undefined &&
  isAtOrBefore(pause.expiresAt, at);

/**
 * `Pending → Resolved` with the answer, only while `expiresAt` is after `at` (I1, I2) and, when the
 * caller names the pause its permit was asked over (`seen`), only while it is still that one.
 */
export function resolveChange(
  pause: PauseRecord,
  answer: PauseAnswer,
  at: Date,
  recipients: PauseRecipients,
  seen?: PauseSeen,
): PauseTransition | undefined {
  return isOpenAt(pause, at) && (seen === undefined || isSeenAs(pause, seen))
    ? closing(pause, resolvedPause(pause, answer, at), at, recipients)
    : undefined;
}

/**
 * `Pending → Taken` with the answer its channel gave at once (`PauseResolution.Decided`), only while
 * `expiresAt` is after `at` like `resolveChange` (I2): an answer at or after the deadline is
 * the expiry's — and only while the pause is still the one the channel was sent (`seen`): an
 * expiry's in-place reassignment during the first send makes its decision stale. No notice (I8).
 */
export function decideChange(
  pause: PauseRecord,
  answer: PauseAnswer,
  at: Date,
  seen: PauseSeen,
): PauseTransition | undefined {
  return isOpenAt(pause, at) && isSeenAs(pause, seen)
    ? { pause: decidedPause(pause, answer, at), notices: [] }
    : undefined;
}

/** `Pending → Cancelled`; a cancel or a tree end at or after `expiresAt` records `Expired` (I3). */
export function cancelChange(
  pause: PauseRecord,
  resolution: PauseCancellation,
  at: Date,
  recipients: PauseRecipients,
): PauseTransition | undefined {
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
): PauseTransition | undefined {
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
): PauseTransition | undefined {
  if (pause.status !== PauseStatus.Resolved) return undefined;
  return {
    pause: untakenPause(pause, resolution, at),
    notices: pause.isSent ? untakenNotices(resolution, at, recipients) : [],
  };
}

/** The reminder of a pending pause, once: `remindAt ≤ at < expiresAt`. */
export function remindChange(
  pause: PauseRecord,
  at: Date,
  recipients: PauseRecipients,
): PauseTransition | undefined {
  if (!isOpenAt(pause, at) || pause.expiresAt === undefined) return undefined;
  if (pause.remindAt === undefined || isBefore(at, pause.remindAt)) return undefined;
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
 * `opened` to the listeners, then, when the pause was changed in place meanwhile (an expiry's
 * reassignment while the first send ran), the `reassigned` it owes its channel and listeners, then, when the pause closed meanwhile, its `closed` to the channel and
 * the listeners, then its `answerNotTaken` when its answer was closed untaken (I8). The notices
 * carry the times the record knows (`askedAt`, `resolvedAt` / `expiresAt`), so `markSent`, which
 * has no `at`, reads no clock of its own.
 */
export function markSentChange(
  pause: PauseRecord,
  recipients: PauseRecipients,
  externalRef?: string,
): PauseTransition {
  if (pause.isSent) return { pause, notices: [] };
  const sent = { ...pause, isSent: true, ...withExternalRef(pause, externalRef) };
  const opened = openingNotices(pause, sent, recipients);
  if (pause.status === PauseStatus.Pending)
    return { pause: sent, notices: [...opened, ...inFirstSendNotices(sent, recipients)] };
  const first = pause.closedFirst ?? pause;
  const closedAt = first.resolvedAt ?? pause.askedAt;
  const untaken =
    pause.answer !== undefined &&
    pause.resolvedAt !== undefined &&
    (pause.resolution === PauseResolution.Cancelled ||
      pause.resolution === PauseResolution.TreeEnded)
      ? untakenNotices(pause.resolution, pause.resolvedAt, recipients)
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
