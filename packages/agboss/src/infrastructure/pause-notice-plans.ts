import { closedAtOf, closedReasonOf } from "./pause-closing.js";
import type { PlannedNotice } from "./pause-mailboxes.js";
import {
  PauseNoticeKind,
  recipientKeysOf,
  type PauseNoticeFacts,
  type PauseRecipients,
} from "./pause-notices.js";
import {
  PauseClosedReason,
  PauseResolution,
  type PauseRecord,
  type PauseTrailRecord,
  type PauseUntakenResolution,
} from "./pause-record.js";
import { definedFields } from "../core/defined-fields.js";

/** The notices a change of a pause writes with it (#935): split from `pause-transitions.ts`. */

/** The notice of `kind` to each receiver of it, due at `at`. */
export function noticesOf(
  recipients: PauseRecipients,
  kind: PauseNoticeKind,
  at: Date,
  facts: PauseNoticeFacts,
): readonly PlannedNotice[] {
  const notice = { kind, writtenAt: at.toISOString(), ...facts };
  return recipientKeysOf(recipients, kind).map((recipient) => ({ recipient, at, notice }));
}

/** The `closed` notice of a record that closed. */
export const closedNotices = (
  closed: PauseRecord,
  at: Date,
  recipients: PauseRecipients,
): readonly PlannedNotice[] =>
  noticesOf(recipients, PauseNoticeKind.Closed, at, {
    reason: closedReasonOf(closed),
    ...(closedAtOf(closed) === undefined ? {} : { closedAt: closedAtOf(closed) }),
  });

/** The `answerNotTaken` notice: why it closed and when. */
export const untakenNotices = (
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

/** The instant of a record's time text; a record stored before `askedAt` (empty) is the epoch. */
export function instantOf(text: string | undefined): Date {
  const instant = new Date(text ?? 0);
  return Number.isNaN(instant.getTime()) ? new Date(0) : instant;
}

/**
 * The index of the first in-place `reassigned` entry of a pause the channel was just sent: one after
 * its own `opened` entry, on a pause no reassignment made (a replacement's own `reassigned` entry is
 * told by `openingNotices`); -1 when it was not changed in place.
 */
const firstChangeOf = (pause: PauseRecord): number =>
  pause.reassignedFrom !== undefined
    ? -1
    : pause.trail.findIndex((entry, at) => at > 0 && entry.action === "reassigned");

/**
 * The notices of a pause whose channel was just asked: `opened` to the listeners — with the deadline
 * the channel was asked with, not one an in-place change set during the send (`inFirstSendNotices`
 * tells that); for a replacement a reassignment made, `reassigned` to the listeners instead (its channel
 * was sent it, the old pause's channel was told `closed`), naming what it moved from — the entry before
 * its own in the chain.
 */
export function openingNotices(
  pause: PauseRecord,
  sent: PauseRecord,
  recipients: PauseRecipients,
): readonly PlannedNotice[] {
  const at = instantOf(pause.askedAt);
  if (pause.reassignedFrom === undefined) {
    // a change in place makes the `opened` entry (the first: `firstChangeOf` is past it) the asked one
    const asked = firstChangeOf(pause) === -1 ? pause : (pause.trail[0] as PauseTrailRecord);
    return noticesOf(
      recipients,
      PauseNoticeKind.Opened,
      at,
      definedFields({ expiresAt: asked.expiresAt }),
    );
  }
  const before = pause.trail.at(-2);
  return noticesOf(
    { listeners: recipients.listeners },
    PauseNoticeKind.Reassigned,
    at,
    definedFields({
      expiresAt: pause.expiresAt,
      previousExpiresAt: before?.expiresAt,
      assignees: sent.assignees,
      previousAssignees: before?.assignees,
      previousTarget: before?.target,
      previousChannel: before?.channel,
      previousExternalRef: before?.externalRef,
    }),
  );
}

/**
 * The `reassigned` notice of a pause that was changed in place (its trail holds a `reassigned` entry
 * after its own `opened`) while its first send was in flight, to the channel that was just sent it
 * and to the listeners: the in-place change wrote none then (nobody was told of the pause yet). It
 * names what the channel was asked with — the `opened` entry, the first of the trail — and what the
 * pause is now. No `previousExternalRef`: a pause not yet sent has no reference.
 */
export function inFirstSendNotices(
  sent: PauseRecord,
  recipients: PauseRecipients,
): readonly PlannedNotice[] {
  const changed = sent.trail[firstChangeOf(sent)];
  if (changed === undefined) return [];
  // a change in place is past the first entry, the `opened` one
  const asked = sent.trail[0] as PauseTrailRecord;
  return noticesOf(
    recipients,
    PauseNoticeKind.Reassigned,
    instantOf(changed.at),
    definedFields({
      expiresAt: sent.expiresAt,
      previousExpiresAt: asked.expiresAt,
      assignees: sent.assignees,
      previousAssignees: asked.assignees,
      previousTarget: asked.target,
      previousChannel: asked.channel,
    }),
  );
}
