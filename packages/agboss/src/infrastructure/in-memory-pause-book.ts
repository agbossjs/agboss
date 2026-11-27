import { randomBytes } from "node:crypto";
import {
  acknowledgedMailbox,
  appendedMailbox,
  claimedMailbox,
  hasNoticeOf,
  isClaimedAt,
  isDueAt,
  isHeldBy,
  isLive,
  isStaleAt,
  mailboxKeyOf,
  mailboxOf,
  releasedMailbox,
  renewedMailbox,
  retriedMailbox,
  setAsideMailbox,
  type PlannedNotice,
  type StoredMailbox,
  type WrittenMailbox,
} from "./pause-mailboxes.js";
import type {
  PauseNoticeClaim,
  PauseNoticeCounts,
  PauseNoticeKind,
  SetAsideMailbox,
} from "./pause-notices.js";
import { compareInstants, copyOf } from "./instants.js";
import { copiedPause } from "./pause-copies.js";
import { assertPauseInstants } from "./pause-instants-valid.js";
import type { PauseRecord } from "./pause-record.js";
import { onceNotices, type PauseTransition } from "./pause-transitions.js";
import type { PauseNoticeFacts, PauseRecipients } from "./pause-notices.js";
import type { SequencedPause } from "./pause-scans.js";

/**
 * The state of `InMemoryPausedExecutionRepository` (#935): the pauses in their insertion order and
 * the mailboxes. A change is planned by a pure function first and applied after, with nothing that
 * can fail in between — so a change and its notices land together or not at all, in one
 * synchronous step.
 */
export class InMemoryPauseBook {
  readonly #pauses = new Map<string, SequencedPause>();
  readonly #mailboxes = new Map<string, StoredMailbox>();
  #sequence = 0;

  /** The pause of the tenant, or `undefined`. */
  find(tenantId: string, pauseId: string): PauseRecord | undefined {
    const stored = this.#pauses.get(JSON.stringify([tenantId, pauseId]));
    return stored === undefined ? undefined : copiedPause(stored.pause);
  }

  /**
   * Every pause in insertion order, with its sequence: the book's own records, to select from —
   * what is handed out is copied (`copiedPause`), never these instances.
   */
  all(): readonly SequencedPause[] {
    return [...this.#pauses.values()];
  }

  /** Adds a pause as the newest one. */
  insert(pause: PauseRecord): void {
    assertPauseInstants(pause);
    this.#sequence += 1;
    this.#pauses.set(JSON.stringify([pause.tenantId, pause.pauseId]), {
      pause: copiedPause(pause),
      seq: this.#sequence,
    });
  }

  /** Plans a change of the pause, applies it with its notices; the changed record, or `undefined`. */
  change(
    tenantId: string,
    pauseId: string,
    plan: (current: PauseRecord) => PauseTransition | undefined,
  ): PauseRecord | undefined {
    const key = JSON.stringify([tenantId, pauseId]);
    const stored = this.#pauses.get(key);
    if (stored === undefined) return undefined;
    const change = plan(copiedPause(stored.pause));
    if (change === undefined) return undefined;
    // refused before anything is applied: the change and its notices land together or not at all
    assertPauseInstants(change.pause);
    if (change.inserted !== undefined) assertPauseInstants(change.inserted);
    this.#pauses.set(key, { ...stored, pause: copiedPause(change.pause) });
    this.#append(change.pause, change.notices);
    if (change.inserted !== undefined) this.insert(change.inserted);
    return copiedPause(change.pause);
  }

  /** Appends the planned notices to their mailboxes, created when absent. */
  #append(pause: PauseRecord, notices: readonly PlannedNotice[]): void {
    for (const planned of notices) {
      const key = mailboxKeyOf(pause.tenantId, pause.pauseId, planned.recipient);
      this.#mailboxes.set(key, appendedMailbox(this.#mailboxes.get(key), pause, planned));
    }
  }

  /** A notice of `kind` once per pause (`noticeOnce…`); whether it wrote. */
  noticeOnce(
    tenantId: string,
    pauseId: string,
    notice: {
      readonly kind: PauseNoticeKind;
      readonly facts: PauseNoticeFacts;
      readonly at: Date;
      readonly recipients: PauseRecipients;
    },
  ): boolean {
    const pause = this.find(tenantId, pauseId);
    if (pause === undefined) return false;
    const already = this.#mailboxesOf(tenantId, pauseId).some((box) =>
      hasNoticeOf(box, notice.kind),
    );
    // planned even when it is not written: an Invalid Date is refused either way
    const once = onceNotices(pause, notice.kind, notice.facts, notice.at, notice.recipients);
    const planned = already ? [] : once;
    this.#append(pause, planned);
    return planned.length > 0;
  }

  #mailboxesOf(tenantId: string, pauseId: string): readonly StoredMailbox[] {
    return [...this.#mailboxes.values()].filter(
      (box) => box.tenantId === tenantId && box.pauseId === pauseId,
    );
  }

  /** Whether a mailbox of the pause keeps it (neither fully delivered nor dead). */
  hasLiveMailbox(pause: PauseRecord): boolean {
    return this.#mailboxesOf(pause.tenantId, pause.pauseId).some(isLive);
  }

  /** Removes pauses and their mailboxes. */
  remove(pauses: readonly PauseRecord[]): void {
    for (const pause of pauses) {
      this.#pauses.delete(JSON.stringify([pause.tenantId, pause.pauseId]));
      for (const box of this.#mailboxesOf(pause.tenantId, pause.pauseId))
        this.#mailboxes.delete(mailboxKeyOf(box.tenantId, box.pauseId, box.recipient));
    }
  }

  claim(
    at: Date,
    limit: number,
    claimFor: number,
    recipients: readonly string[],
  ): PauseNoticeClaim[] {
    const due = [...this.#mailboxes.values()]
      .filter((box) => recipients.includes(box.recipient) && isDueAt(box, at))
      .sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime())
      .slice(0, limit);
    return due.map((box) => {
      const until = new Date(at.getTime() + claimFor);
      const token = randomBytes(16).toString("hex");
      const claimed = claimedMailbox(box, token, until);
      this.#mailboxes.set(mailboxKeyOf(box.tenantId, box.pauseId, box.recipient), claimed);
      return { mailbox: mailboxOf(claimed), token, until: copyOf(until) };
    });
  }

  /** The mailbox `claim` names while the claim's token is still the mailbox's. */
  #held(claim: PauseNoticeClaim): readonly [string, StoredMailbox] | undefined {
    const { tenantId, pauseId, recipient } = claim.mailbox;
    const key = mailboxKeyOf(tenantId, pauseId, recipient);
    const box = this.#mailboxes.get(key);
    return box !== undefined && isHeldBy(box, claim.token) ? [key, box] : undefined;
  }

  ack(claim: PauseNoticeClaim, at: Date): PauseNoticeClaim | undefined {
    const held = this.#held(claim);
    if (held === undefined || !isClaimedAt(held[1], at)) return undefined;
    const acknowledged = acknowledgedMailbox(held[1], at);
    this.#mailboxes.set(held[0], acknowledged);
    return acknowledged.claim === undefined
      ? undefined
      : {
          mailbox: mailboxOf(acknowledged),
          token: claim.token,
          until: copyOf(acknowledged.claim.until),
        };
  }

  renew(claim: PauseNoticeClaim, at: Date, claimFor: number): PauseNoticeClaim | undefined {
    const held = this.#held(claim);
    if (held === undefined || !isClaimedAt(held[1], at)) return undefined;
    const renewed = renewedMailbox(held[1], new Date(at.getTime() + claimFor));
    this.#mailboxes.set(held[0], renewed);
    return { mailbox: mailboxOf(renewed), token: claim.token, until: copyOf(renewed.claim.until) };
  }

  retry(claim: PauseNoticeClaim, nextAttemptAt: Date, problem: string): boolean {
    const held = this.#held(claim);
    if (held !== undefined)
      this.#mailboxes.set(held[0], retriedMailbox(held[1], nextAttemptAt, problem));
    return held !== undefined;
  }

  setAside(claim: PauseNoticeClaim, problem: string): boolean {
    const held = this.#held(claim);
    if (held !== undefined) this.#mailboxes.set(held[0], setAsideMailbox(held[1], problem));
    return held !== undefined;
  }

  setAsideStale(
    writtenBefore: Date,
    at: Date,
    problem: string,
    limit: number,
  ): readonly SetAsideMailbox[] {
    const stale = [...this.#mailboxes.values()]
      .filter((box): box is WrittenMailbox => isStaleAt(box, writtenBefore, at))
      .sort((a, b) => compareInstants(a.headWrittenAt, b.headWrittenAt))
      .slice(0, limit);
    for (const box of stale)
      this.#mailboxes.set(
        mailboxKeyOf(box.tenantId, box.pauseId, box.recipient),
        setAsideMailbox(releasedMailbox(box), problem),
      );
    return stale.map(({ tenantId, pauseId, recipient }) => ({ tenantId, pauseId, recipient }));
  }

  count(): PauseNoticeCounts {
    const boxes = [...this.#mailboxes.values()];
    return { live: boxes.filter(isLive).length, dead: boxes.filter((box) => box.isDead).length };
  }
}
