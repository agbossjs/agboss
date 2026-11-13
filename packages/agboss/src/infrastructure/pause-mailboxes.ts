import { PauseNoticeKind, type PauseMailbox, type PauseNotice } from "./pause-notices.js";

/**
 * The rules of a mailbox (#935, #910 I8–I10), pure functions over one mailbox — shared by every
 * store of the core, so the in-memory and the SQLite store cannot read them differently: the head
 * rule of an append, the claim, the token-checked acknowledgement, retry and set-aside.
 */

/** A mailbox as a store keeps it: with the claim on it, if any. */
export interface StoredMailbox extends PauseMailbox {
  readonly claim?: { readonly token: string; readonly until: Date };
}

/** One notice to write: to whom, and the instant it is due (the transition's `at`). */
export interface PlannedNotice {
  readonly recipient: string;
  readonly at: Date;
  readonly notice: Omit<PauseNotice, "seq">;
}

/** The mailbox a receiver sees: without the claim's bookkeeping. */
export const mailboxOf = (stored: StoredMailbox): PauseMailbox => ({
  tenantId: stored.tenantId,
  pauseId: stored.pauseId,
  recipient: stored.recipient,
  notices: stored.notices,
  delivered: stored.delivered,
  attempts: stored.attempts,
  nextAttemptAt: stored.nextAttemptAt,
  headWrittenAt: stored.headWrittenAt,
  isDead: stored.isDead,
  problem: stored.problem,
});

/** The key one mailbox is stored under. */
export const mailboxKeyOf = (tenantId: string, pauseId: string, recipient: string): string =>
  JSON.stringify([tenantId, pauseId, recipient]);

/** Whether the mailbox has notices no receiver acknowledged. */
export const hasUndelivered = (mailbox: PauseMailbox): boolean =>
  mailbox.delivered < mailbox.notices.length;

/** Whether the mailbox keeps its pause record: neither fully delivered nor dead (I11). */
export const isLive = (mailbox: PauseMailbox): boolean =>
  !mailbox.isDead && hasUndelivered(mailbox);

/** Whether a claim is held at `at`. */
const isClaimedAt = (mailbox: StoredMailbox, at: Date): boolean =>
  mailbox.claim !== undefined && mailbox.claim.until > at;

/** Whether `claimNoticesDue(at)` may claim it. */
export const isDueAt = (mailbox: StoredMailbox, at: Date): boolean =>
  isLive(mailbox) && mailbox.nextAttemptAt <= at && !isClaimedAt(mailbox, at);

/** Whether `setAsideStaleNoticesBefore(writtenBefore, at)` takes it. */
export const isStaleAt = (mailbox: StoredMailbox, writtenBefore: Date, at: Date): boolean =>
  isLive(mailbox) &&
  mailbox.headWrittenAt !== undefined &&
  mailbox.headWrittenAt < writtenBefore.toISOString() &&
  !isClaimedAt(mailbox, at);

/**
 * `planned` appended to its mailbox (created when absent, due at once). The head (V3.1): an append
 * to a mailbox with nothing undelivered makes the new notice the head and the mailbox due now; an
 * append behind an undelivered head changes neither.
 */
export function appendedMailbox(
  existing: StoredMailbox | undefined,
  site: { readonly tenantId: string; readonly pauseId: string },
  planned: PlannedNotice,
): StoredMailbox {
  const { recipient, at } = planned;
  const base: StoredMailbox = existing ?? {
    ...site,
    recipient,
    notices: [],
    delivered: 0,
    attempts: 0,
    nextAttemptAt: at,
    isDead: false,
  };
  const isIdle = !hasUndelivered(base);
  const notice: PauseNotice = { ...planned.notice, seq: base.notices.length + 1 };
  const notices = [...base.notices, notice];
  return isIdle
    ? {
        ...base,
        notices,
        headWrittenAt: notice.writtenAt,
        nextAttemptAt: at,
        attempts: 0,
        problem: undefined,
      }
    : { ...base, notices };
}

/** Whether any notice of the mailbox is of `kind`. */
export const hasNoticeOf = (mailbox: PauseMailbox, kind: PauseNoticeKind): boolean =>
  mailbox.notices.some((notice) => notice.kind === kind);

/** The mailbox claimed under `token` until `until`. */
export const claimedMailbox = (
  mailbox: StoredMailbox,
  token: string,
  until: Date,
): StoredMailbox => ({ ...mailbox, claim: { token, until } });

/** The mailbox without its claim. */
export const releasedMailbox = (mailbox: StoredMailbox): StoredMailbox => ({
  ...mailbox,
  claim: undefined,
});

/** Whether `token` is the mailbox's claim. */
export const isHeldBy = (mailbox: StoredMailbox, token: string): boolean =>
  mailbox.claim?.token === token;

/**
 * The mailbox after its head notice is acknowledged: the next notice is the head and due at once,
 * attempts start over; the claim stays while notices remain and is released after the last.
 */
export function acknowledgedMailbox(mailbox: StoredMailbox, at: Date): StoredMailbox {
  const delivered = mailbox.delivered + 1;
  const next = mailbox.notices[delivered];
  const moved: StoredMailbox = {
    ...mailbox,
    delivered,
    attempts: 0,
    nextAttemptAt: at,
    headWrittenAt: next?.writtenAt,
    problem: undefined,
  };
  return next === undefined ? releasedMailbox(moved) : moved;
}

/** The mailbox after a failed attempt: one more, due at `nextAttemptAt`, the claim released. */
export const retriedMailbox = (
  mailbox: StoredMailbox,
  nextAttemptAt: Date,
  problem: string,
): StoredMailbox => ({
  ...releasedMailbox(mailbox),
  attempts: mailbox.attempts + 1,
  nextAttemptAt,
  problem,
});

/** The mailbox set aside: dead, never claimed again, the claim released. */
export const setAsideMailbox = (mailbox: StoredMailbox, problem: string): StoredMailbox => ({
  ...releasedMailbox(mailbox),
  isDead: true,
  problem,
});
