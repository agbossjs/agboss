import type { PauseActor } from "../channels/pause-contexts.js";
import type { PauseRespondent } from "../pause/respondent.js";
import type {
  PauseClosedReason,
  PauseExpiryBound,
  PauseRecipients,
  PauseRecord,
  PauseStatus,
} from "./pause-record.js";

/**
 * The notices of a pause (#935, #910): what the pause store writes, in the same transaction as the
 * change that causes them, into one ordered mailbox per pause and receiver — claimed, acknowledged,
 * retried and set aside atomically. The store never decides who listens (`PauseRecipients` says).
 */

export { NO_RECIPIENTS, type PauseRecipients } from "./pause-record.js";

/** What a notice says happened. */
export enum PauseNoticeKind {
  /** Its channel was asked and is awaiting a reply: told to listeners only. */
  Opened = "opened",
  /** It closed. */
  Closed = "closed",
  /** A recorded answer its run never applied (Q2). */
  AnswerNotTaken = "answer-not-taken",
  /** An answered branch's launch failed (#945, Q11). */
  JoinFailed = "join-failed",
  /** Its deadline moved. */
  Extended = "extended",
  /** Its deadline is near: the reminder. */
  Expiring = "expiring",
  /**
   * It moved to other assignees, in place (to the channel that sent it and the listeners), or to
   * another target or channel (to the listeners only: the new channel was sent it, the old one is told `closed`).
   */
  Reassigned = "reassigned",
}

/** One notice of a mailbox. */
export interface PauseNotice {
  /** 1, 2, … within its mailbox. */
  readonly seq: number;
  readonly kind: PauseNoticeKind;
  /** The transition's `at` (ISO 8601). */
  readonly writtenAt: string;
  /** `closed`, `answerNotTaken` (why: cancelled or tree-ended). */
  readonly reason?: PauseClosedReason;
  /** `closed`, `answerNotTaken`: when it closed (the untaken close's time). */
  readonly closedAt?: string;
  /** `opened`, `extended`, `expiring`. */
  readonly expiresAt?: string;
  /** `extended`. */
  readonly previousExpiresAt?: string;
  /** `reassigned`: who the pause was for before (absent: nobody in particular). */
  readonly previousAssignees?: readonly string[];
  /** `reassigned`: who it is for now (absent: nobody in particular). */
  readonly assignees?: readonly string[];
  /** `reassigned`: the target it waited under before. */
  readonly previousTarget?: string;
  /** `reassigned`: the channel it was asked on before (absent: none). */
  readonly previousChannel?: string;
  /** `reassigned`: the id its channel's system gave it before (absent: none). */
  readonly previousExternalRef?: string;
  /** `joinFailed`: the launch key `${executionId}:${nodeId}:${visit}`. */
  readonly launch?: string;
  /** `joinFailed`: the failing branch's error code (`step.pause-expired`). */
  readonly errorCode?: string;
}

/** What a notice carries beside its place and time: what `noticeOnce…` is given. */
export type PauseNoticeFacts = Omit<PauseNotice, "seq" | "kind" | "writtenAt">;

/** One receiver's notices of one pause, in the order written. */
export interface PauseMailbox {
  readonly tenantId: string;
  readonly pauseId: string;
  /** `"channel:<name>"` or `"listener:<name>"`. */
  readonly recipient: string;
  /** Every notice, in `seq` order. */
  readonly notices: readonly PauseNotice[];
  /** How many from the start are acknowledged. */
  readonly delivered: number;
  /** Failed attempts of the head notice. */
  readonly attempts: number;
  readonly nextAttemptAt: Date;
  /** The `writtenAt` of the first undelivered notice; absent when everything is delivered. */
  readonly headWrittenAt?: string;
  /** Set aside: never claimed again. */
  readonly isDead: boolean;
  /** The last failure's fixed code, never a message. */
  readonly problem?: string;
}

/** A mailbox claimed for delivery: only its token acknowledges, retries or sets it aside. */
export interface PauseNoticeClaim {
  readonly mailbox: PauseMailbox;
  readonly token: string;
  readonly until: Date;
}

/**
 * Where a due-scan (`findPendingByExpiresAtBefore`, `findPendingByRemindAtBefore`) continues: after the last pause of the page
 * before, by the scan's own order `(time, tenantId, pauseId)` — a keyset, so pauses that stay
 * pending (nobody can move them) are passed, never read again within one sweep (#1070, #1072).
 */
export interface PauseScanAfter {
  /** The last pause's time on the scanned column (`expiresAt`, or `remindAt`), ISO text. */
  readonly at: string;
  readonly tenantId: string;
  readonly pauseId: string;
}

/** A page of pauses; `next` is the opaque cursor of the page after it, absent on the last. */
export interface PausePage {
  readonly pauses: readonly PauseRecord[];
  readonly next?: string;
}

/** What `findPageByTenantId` selects. */
export interface PauseFilter {
  /** Non-empty. */
  readonly statuses: readonly PauseStatus[];
  /** Only pauses waiting under this pause target. */
  readonly target?: string;
  /** Only pauses whose `expiresAt` is before it. */
  readonly expiresBefore?: Date;
  /** Only pauses asked through this channel (its name). */
  readonly channel?: string;
  /** Only pauses with this one among their `assignees`. */
  readonly assignee?: string;
  /** Only the pause with this `externalRef`. */
  readonly externalRef?: string;
}

/** How many mailboxes wait for delivery and how many were set aside. */
export interface PauseNoticeCounts {
  /** Not dead, with undelivered notices. */
  readonly live: number;
  readonly dead: number;
}

/** A mailbox set aside, as `setAsideStaleNoticesBefore` names it. */
export interface SetAsideMailbox {
  readonly tenantId: string;
  readonly pauseId: string;
  readonly recipient: string;
}

/** The deadline change `extend…` applies. */
export interface PauseDeadlineChange {
  /** The new deadline (ISO 8601); after `at` and after the stored one. */
  readonly expiresAt: string;
  /**
   * The deadline the caller read and extends from (ISO 8601): the change applies only while the
   * stored deadline is still this one — the compare of the compare-and-set (#1099) — and the
   * `extended` notice names it as `previousExpiresAt`.
   */
  readonly previousExpiresAt: string;
  /** The new reminder time (ISO 8601); absent: none. */
  readonly remindAt?: string;
  /** Who changed it; absent for the framework's own. Kept in the chain of custody. */
  readonly actor?: PauseActor;
  /**
   * The most `timeout-changed` entries the pause's chain of custody may hold (the targets'
   * `escalationLimits.maxExtensions`, tightened along its chain): refused, atomically with the
   * write, when the chain already holds that many.
   */
  readonly maxExtensions?: number;
}

/**
 * The state of the pause a reassignment was permitted and planned against (#1307): the store applies
 * the change only while the pause is still exactly this — the compare of a compare-and-set, as
 * `previousExpiresAt` is for an extension — so a reassignment that ran between the permit and the
 * write is never overwritten with a plan made for the older state.
 */
export interface PauseSeen {
  /** How many entries the chain of custody held: any reassignment, extension or move adds one. */
  readonly trailLength: number;
  /** Who the pause was for; absent: nobody in particular. */
  readonly assignees?: readonly string[];
  /** The deadline the pause had (ISO 8601); absent: none. */
  readonly expiresAt?: string;
  /**
   * Whether its channel had been asked (`markSent`): a pause marked sent since the plan is no longer
   * the one it was made for — the step that asked it may be acting on what `send` returned.
   */
  readonly isSent: boolean;
}

/** A deadline a reassignment sets: what the pause waits until now, and its reminder. */
export interface PauseDeadlineSet {
  /** The new deadline (ISO 8601); absent: none. */
  readonly expiresAt?: string;
  readonly expiryBound?: PauseExpiryBound;
  /** The new reminder time (ISO 8601); absent: none. */
  readonly remindAt?: string;
}

/**
 * A reassignment of a pause that stays the same pause (#1307d): same id, same target and channel,
 * its `externalRef` kept — a queue claim or release, a new pool, a new deadline. Told to its channel
 * as `onPauseReassigned`. A `reassign…` call takes this when it has no `pauseId`.
 */
export interface PauseInPlaceReassignment {
  /** The state the change was planned against; absent: unguarded (a store's own test). The core always sets it. */
  readonly seen?: PauseSeen;
  /** None: the pause keeps its own. */
  readonly pauseId?: never;
  /** Who the pause is for now (one to 100 key's texts, none twice); absent: nobody in particular (released). */
  readonly assignees?: readonly string[];
  readonly actor?: PauseActor;
  /** Why, already masked by the pause's workflow's PII policy: kept in the chain of custody. */
  readonly reason?: string;
  /**
   * An expiry's reassignment: applied only while the pause's deadline is at or before the write
   * (a due-at compare-and-set, not "still open"); the pause waits for this deadline from now on.
   */
  readonly due?: PauseDeadlineSet;
  /** An operator's new deadline: applied with the reassignment while the pause is open. */
  readonly timeout?: PauseDeadlineSet;
  /**
   * The most reassignments the pause's chain of custody may hold (the target's
   * `escalationLimits.maxReassignments`, tightened along its chain): refused, atomically with the
   * write, when the chain already holds that many.
   */
  readonly maxReassignments?: number;
  /** The call set a deadline: it counts as an extension (a `timeout-changed` entry, refused at `maxExtensions`). */
  readonly countsAsExtension?: true;
  /** The chain's `escalationLimits.maxExtensions`, checked in the same write when `countsAsExtension`. */
  readonly maxExtensions?: number;
}

/** The replacement a `reassign…` makes (#946): its id and the addressee; the store copies the rest from the old pause. */
export interface PauseReplacement {
  /** As `PauseInPlaceReassignment.seen`. */
  readonly seen?: PauseSeen;
  /** The new pause's id: a random 128-bit token the caller made (`newPauseId()`), never the old one's. */
  readonly pauseId: string;
  /** The addressees (key's texts, #589; one to 100, none twice): who the channel asks now; absent: nobody in particular. */
  readonly assignees?: readonly string[];
  /** Who reassigned it; absent for the framework's own (an expiry). */
  readonly actor?: PauseActor;
  /** Why, already masked by the pause's workflow's PII policy: kept in the chain of custody. */
  readonly reason?: string;
  /**
   * An expiry's reassignment (#1310a): applied only while the pause's deadline is at or before the
   * write (a due-at compare-and-set, not "still open"), and the replacement waits for `expiresAt`
   * (absent: no deadline) bound by `expiryBound`, with no reminder — a reassignment otherwise keeps
   * the old deadline.
   */
  readonly due?: PauseDeadlineSet;
  /** An operator's new deadline for the replacement: applied while the old pause is open; no reminder is kept unless it names one. */
  readonly timeout?: PauseDeadlineSet;
  /** Where the replacement waits when it is not the old pause's own target and channel. */
  readonly to?: {
    readonly target: string;
    readonly respondent: PauseRespondent;
    /** Absent: the target's pauses are asked of nobody (an owner's). */
    readonly channel?: string;
  };
  /** As `PauseInPlaceReassignment.maxReassignments`. */
  readonly maxReassignments?: number;
  /** The call set a deadline: it counts as an extension (a `timeout-changed` entry, refused at `maxExtensions`). */
  readonly countsAsExtension?: true;
  /** The chain's `escalationLimits.maxExtensions`, checked in the same write when `countsAsExtension`. */
  readonly maxExtensions?: number;
}

/** What `reassign…` takes: a replacement (it has the new pause's `pauseId`), or an in-place change. */
export type PauseReassignmentChange = PauseReplacement | PauseInPlaceReassignment;

/** Whether a reassignment keeps the pause (it names no new `pauseId`). */
export const isInPlace = (change: PauseReassignmentChange): change is PauseInPlaceReassignment =>
  !("pauseId" in change);

/**
 * The receivers of a kind: `opened` goes to listeners only, every other kind to the channel too. A
 * `reassigned` notice that moves a pause to another channel is written with recipients that name no
 * channel (the old one is told `closed`, the new one was sent it).
 */
export function recipientKeysOf(
  recipients: PauseRecipients,
  kind: PauseNoticeKind,
): readonly string[] {
  const listeners = recipients.listeners.map((name) => `listener:${name}`);
  const channel =
    recipients.channel === undefined || kind === PauseNoticeKind.Opened
      ? []
      : [`channel:${recipients.channel}`];
  return [...new Set([...channel, ...listeners])];
}
