import { PauseNoticeKind, type PauseRecipients, type PauseTimeoutChange } from "./pause-notices.js";
import { noticesOf } from "./pause-notice-plans.js";
import type { PauseTrailEntry } from "../channels/pause-contexts.js";
import { PauseExpiryBound, type PauseRecord } from "./pause-record.js";
import { isAtOrBefore, sameInstant } from "./instants.js";
import { isWithinCap } from "./pause-limits-stored.js";
import { isSeenAs } from "./pause-seen.js";
import { isOpenAt, type PauseTransition } from "./pause-transitions.js";

/** The change of a pending pause's deadline (`app.setPauseTimeout`, #1307): split from `pause-transitions.ts`. */

/**
 * Whether the change applies to the pause now: open, over the deadline the caller read (absent: none)
 * and the pause as it was read, to none or to a time after `at` (never to a past time, I3), under
 * the count of changes the record's `escalationLimits.maxExtensions` allows.
 */
function isChangeable(pause: PauseRecord, change: PauseTimeoutChange, at: Date): boolean {
  if (!isOpenAt(pause, at)) return false;
  if (!sameInstant(pause.expiresAt, change.previousExpiresAt) || !isSeenAs(pause, change.seen))
    return false;
  if (change.expiresAt !== undefined && isAtOrBefore(change.expiresAt, at)) return false;
  // the total wait: the record's own cap, whatever the caller planned
  if (!isWithinCap(pause.maxExpiresAt, change.expiresAt)) return false;
  const changes = pause.trail.filter((entry) => entry.action === "timeout-changed").length;
  // the limit is the record's own: never the caller's say, never the application's present configuration
  return changes < (pause.escalationLimits.maxExtensions ?? Infinity);
}

/**
 * A pending pause's deadline changed (`app.setPauseTimeout`): later, earlier, set or taken away —
 * never to a past time (I3), and only from the deadline the caller read: whoever read an older one
 * lost to a writer that moved it. A pause that is not open takes no change.
 */
export function timeoutChange(
  pause: PauseRecord,
  change: PauseTimeoutChange,
  at: Date,
  recipients: PauseRecipients,
): PauseTransition | undefined {
  if (!isChangeable(pause, change, at)) return undefined;
  return {
    pause: {
      ...pause,
      expiresAt: change.expiresAt,
      expiryBound: boundOf(pause, change),
      remindAt: change.remindAt,
      trail: [...pause.trail, timeoutChangedEntryOf(pause, change, at)],
    },
    notices: noticesOf(recipients, PauseNoticeKind.TimeoutChanged, at, {
      ...(change.expiresAt === undefined ? {} : { expiresAt: change.expiresAt }),
      ...(pause.expiresAt === undefined ? {} : { previousExpiresAt: pause.expiresAt }),
      ...(change.actor === undefined ? {} : { actor: change.actor }),
      ...(change.reason === undefined ? {} : { changeReason: change.reason }),
    }),
  };
}

/**
 * The source of the deadline after a change: the pause's own — except one set exactly to the deadline
 * the pause was made under, which keeps that deadline's source (a quorum's stays the quorum's, not the
 * run's the tie of `effectiveBoundOf` would make it).
 */
function boundOf(pause: PauseRecord, change: PauseTimeoutChange): PauseExpiryBound {
  const { expiryBound } = pause;
  const isBound = change.expiresAt !== undefined && sameInstant(change.expiresAt, pause.boundAt);
  return isBound && expiryBound !== undefined ? expiryBound : PauseExpiryBound.Pause;
}

/** The entry a deadline change adds to the chain of custody: who moved it, when, to what, why. */
function timeoutChangedEntryOf(
  pause: PauseRecord,
  change: PauseTimeoutChange,
  at: Date,
): PauseTrailEntry {
  return {
    action: "timeout-changed",
    at,
    ...(change.actor === undefined ? {} : { actor: change.actor }),
    target: pause.target,
    ...(pause.channel === undefined ? {} : { channel: pause.channel }),
    ...(pause.assignees === undefined ? {} : { assignees: pause.assignees }),
    ...(change.expiresAt === undefined ? {} : { expiresAt: change.expiresAt }),
    ...(pause.externalRef === undefined ? {} : { externalRef: pause.externalRef }),
    ...(change.reason === undefined ? {} : { reason: change.reason }),
  };
}
