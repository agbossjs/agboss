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
 * The notices of a pause whose channel was just asked: `opened` to the listeners; for a replacement
 * a reassignment made, `reassigned` to the listeners instead (its channel was sent it, the old
 * pause's channel was told `closed`), naming what it moved from — the entry before its own in the chain.
 */
export function openingNotices(
  pause: PauseRecord,
  sent: PauseRecord,
  recipients: PauseRecipients,
): readonly PlannedNotice[] {
  const at = instantOf(pause.askedAt);
  if (pause.reassignedFrom === undefined)
    return noticesOf(
      recipients,
      PauseNoticeKind.Opened,
      at,
      definedFields({ expiresAt: pause.expiresAt }),
    );
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
 * names what the channel was asked on — the entry before the first change, as far as that entry
 * records it (the `opened` entry holds the target and channel; the deadline and assignees only when
 * it names them) — and what the pause is now. A replacement (`reassignedFrom`) has its own `reassigned` entry: its listeners hear that one.
 */
export function inFirstSendNotices(
  sent: PauseRecord,
  recipients: PauseRecipients,
): readonly PlannedNotice[] {
  if (sent.reassignedFrom !== undefined) return [];
  const index = sent.trail.findIndex((entry, at) => at > 0 && entry.action === "reassigned");
  const before = sent.trail[index - 1];
  const changed = sent.trail[index];
  if (before === undefined || changed === undefined) return [];
  return noticesOf(
    recipients,
    PauseNoticeKind.Reassigned,
    instantOf(changed.at),
    definedFields({
      expiresAt: sent.expiresAt,
      previousExpiresAt: before.expiresAt,
      assignees: sent.assignees,
      previousAssignees: before.assignees,
      previousTarget: before.target,
      previousChannel: before.channel,
      previousExternalRef: before.externalRef,
    }),
  );
}
