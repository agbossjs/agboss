import type {
  PauseClosedReason,
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

/** A page of pauses; `next` is the opaque cursor of the page after it, absent on the last. */
export interface PausePage {
  readonly pauses: readonly PauseRecord[];
  readonly next?: string;
}

/** What `findPageByTenantId` selects. */
export interface PauseFilter {
  /** Non-empty. */
  readonly statuses: readonly PauseStatus[];
  readonly channel?: string;
  /** Only pauses whose `expiresAt` is before it. */
  readonly expiresBefore?: Date;
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
export interface PauseExtension {
  /** The new deadline (ISO 8601); after `at`. */
  readonly expiresAt: string;
  /** The new reminder time (ISO 8601); absent: none. */
  readonly remindAt?: string;
}

/** The receivers of a kind: `opened` goes to listeners only, every other kind to the channel too. */
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
