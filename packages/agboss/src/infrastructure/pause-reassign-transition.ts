import {
  isInPlace,
  offeredLimitsOf,
  PauseNoticeKind,
  recipientKeysOf,
  type PauseInPlaceReassignment,
  type PauseReassignmentChange,
  type PauseRecipients,
  type PauseReplacement,
} from "./pause-notices.js";
import type { PauseRecord, PauseTrailRecord } from "./pause-record.js";
import { narrowedLimits } from "./pause-limits-stored.js";
import { reassignedPause, replacementPause, replacementStepKeyOf } from "./pause-replacement.js";
import { isSeenAs } from "./pause-seen.js";
import { closing, isDueAt, isOpenAt, type PauseChange } from "./pause-transitions.js";

/**
 * `Pending → Cancelled / Reassigned` and the replacement made (#946), or the pause changed in place
 * (#1307d), only while the pause is open at `at`: no deadline, or one after it — a deadline at `at`
 * is over (I2); an expiry's reassignment (`due`) the other way round: only while the deadline is at
 * or before `at`. Never past the record's `escalationLimits.maxReassignments` (narrowed by the
 * destination of a move): a chain of custody that holds that many reassignments takes no more, in the
 * same transaction as the write; a move to another target leaves the replacement with the narrowed limits. The replacement keeps the
 * deadline and the rest of the question, takes the next free `~r<n>` of the step's key among
 * `takenStepKeys` (the step keys of the tree), is unsent: its `opened` is written when its channel was
 * asked. The old pause's `closed` goes to its channel when it was sent and listens — the listeners
 * hear one `reassigned` instead, from the replacement's `markSent`.
 */

/** How many reassignments a pause's chain of custody holds. */
export const reassignmentsOf = (pause: Pick<PauseRecord, "trail">): number =>
  pause.trail.filter((entry) => entry.action === "reassigned").length;

/**
 * Whether the change may apply to the pause now: still as the permit saw it, open (or due, for an
 * expiry's), and under its limit.
 */
function isApplicable(pause: PauseRecord, change: PauseReassignmentChange, at: Date): boolean {
  if (!isSeenAs(pause, change.seen)) return false;
  const isExpiry = change.due !== undefined;
  if (isExpiry ? !isDueAt(pause, at) : !isOpenAt(pause, at)) return false;
  // the limits are the record's own, narrowed by the destination of a move: never the application's present configuration
  const { escalationLimits } = narrowedLimits(pause, offeredLimitsOf(change));
  // no limit named: no count reaches it
  if (reassignmentsOf(pause) >= (escalationLimits.maxReassignments ?? Infinity)) return false;
  return !(
    change.countsAsExtension === true &&
    extensionsOf(pause) >= (escalationLimits.maxExtensions ?? Infinity)
  );
}

/** How many deadline changes a pause's chain of custody holds. */
const extensionsOf = (pause: Pick<PauseRecord, "trail">): number =>
  pause.trail.filter((entry) => entry.action === "timeout-changed").length;

/** The recipients of the old pause's `closed`: its channel only — listeners hear `reassigned`. */
const channelOnly = (recipients: PauseRecipients): PauseRecipients => ({
  ...recipients,
  listeners: [],
});

/** The entry an in-place reassignment adds to the chain of custody. */
function inPlaceEntryOf(
  pause: PauseRecord,
  change: PauseInPlaceReassignment,
  expiresAt: string | undefined,
  at: Date,
): PauseTrailRecord {
  const { assignees, actor, reason } = change;
  return {
    action: "reassigned",
    at: at.toISOString(),
    ...(actor === undefined ? {} : { actor }),
    target: pause.target,
    ...(pause.channel === undefined ? {} : { channel: pause.channel }),
    ...(assignees === undefined ? {} : { assignees }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(pause.externalRef === undefined ? {} : { externalRef: pause.externalRef }),
    ...(reason === undefined ? {} : { reason }),
  };
}

/** The pause as an in-place reassignment leaves it. */
function reassignedInPlace(
  pause: PauseRecord,
  change: PauseInPlaceReassignment,
  at: Date,
): PauseRecord {
  const deadline = change.due ?? change.timeout;
  const expiresAt = deadline === undefined ? pause.expiresAt : deadline.expiresAt;
  return {
    ...withoutKeys(pause, deadline === undefined ? ["assignees"] : ["assignees", ...DEADLINE_KEYS]),
    ...deadline,
    ...(change.assignees === undefined ? {} : { assignees: change.assignees }),
    trail: [
      ...pause.trail,
      inPlaceEntryOf(pause, change, expiresAt, at),
      ...(change.countsAsExtension === true
        ? [{ ...inPlaceEntryOf(pause, change, expiresAt, at), action: "timeout-changed" as const }]
        : []),
    ],
  };
}

const DEADLINE_KEYS: readonly string[] = ["expiresAt", "expiryBound", "remindAt"];

/** The pause without the named fields: a reassignment that sets them replaces what was there. */
const withoutKeys = (pause: PauseRecord, keys: readonly string[]): PauseRecord =>
  Object.fromEntries(Object.entries(pause).filter(([key]) => !keys.includes(key))) as PauseRecord;

/** The notices an in-place reassignment writes: to the channel that listens and the listeners, once the pause was sent. */
function inPlaceNotices(
  before: PauseRecord,
  after: PauseRecord,
  at: Date,
  recipients: PauseRecipients,
) {
  if (!before.isSent) return [];
  const notice = {
    kind: PauseNoticeKind.Reassigned,
    writtenAt: at.toISOString(),
    ...(after.expiresAt === undefined ? {} : { expiresAt: after.expiresAt }),
    ...(before.expiresAt === undefined ? {} : { previousExpiresAt: before.expiresAt }),
    ...(after.assignees === undefined ? {} : { assignees: after.assignees }),
    ...(before.assignees === undefined ? {} : { previousAssignees: before.assignees }),
    previousTarget: before.target,
    ...(before.channel === undefined ? {} : { previousChannel: before.channel }),
    ...(before.externalRef === undefined ? {} : { previousExternalRef: before.externalRef }),
  };
  return recipientKeysOf(recipients, PauseNoticeKind.Reassigned).map((recipient) => ({
    recipient,
    at,
    notice,
  }));
}

/** The in-place reassignment: the same pause, other assignees (and deadline), a `reassigned` notice; `undefined` when it does not apply. */
function inPlaceChange(
  pause: PauseRecord,
  change: PauseInPlaceReassignment,
  at: Date,
  recipients: PauseRecipients,
): PauseChange {
  const after = reassignedInPlace(pause, change, at);
  return { pause: after, notices: inPlaceNotices(pause, after, at, recipients) };
}

/** The replacement: the old pause closed `Reassigned`, the replacement inserted unsent. */
function replacementChange(
  pause: PauseRecord,
  replacement: PauseReplacement,
  takenStepKeys: ReadonlySet<string>,
  at: Date,
  recipients: PauseRecipients,
): PauseChange {
  const stepKey = replacementStepKeyOf(pause, takenStepKeys);
  return {
    ...closing(pause, reassignedPause(pause, replacement.pauseId, at), at, channelOnly(recipients)),
    inserted: replacementPause(pause, { ...replacement, stepKey }, at),
  };
}

export function reassignChange(
  pause: PauseRecord,
  change: PauseReassignmentChange,
  takenStepKeys: ReadonlySet<string>,
  at: Date,
  recipients: PauseRecipients,
): PauseChange | undefined {
  if (!isApplicable(pause, change, at)) return undefined;
  return isInPlace(change)
    ? inPlaceChange(pause, change, at, recipients)
    : replacementChange(pause, change, takenStepKeys, at, recipients);
}
