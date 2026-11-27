import type { Milliseconds } from "../units/index.js";
import { compareInstants, isAtOrBefore, isBefore } from "./instants.js";
import { copiedPause } from "./pause-copies.js";
import type { InMemoryPauseBook } from "./in-memory-pause-book.js";
import { InMemoryPausedRunRepository } from "./in-memory-paused-runs.js";
import type {
  PauseFilter,
  PauseNoticeClaim,
  PauseNoticeCounts,
  PauseNoticeFacts,
  PauseNoticeKind,
  PausePage,
  PauseScanAfter,
  PauseRecipients,
  SetAsideMailbox,
} from "./pause-notices.js";
import { isExpiredPause, PauseStatus, type PauseRecord } from "./pause-record.js";
import {
  assertListing,
  compareText,
  assertScanLimit,
  firstByTime,
  inScope,
  pageOf,
  seqOfCursor,
  type SequencedPause,
  type Timed,
} from "./pause-scans.js";

/** Whether a pause at `time` comes after the keyset `after` in `(time, tenantId, pauseId)` order. */
const isPast = (
  after: PauseScanAfter,
  time: Date,
  pause: Pick<PauseRecord, "tenantId" | "pauseId">,
): boolean =>
  (compareInstants(time, after.at) ||
    compareText(pause.tenantId, after.tenantId) ||
    compareText(pause.pauseId, after.pauseId)) > 0;

/** Whether a pause is open: `Pending` or `Resolved`. */
const isOpen = (pause: PauseRecord): boolean =>
  pause.status === PauseStatus.Pending || pause.status === PauseStatus.Resolved;

/**
 * The reads of the in-memory pause store and its mailboxes — the scans, the retention's
 * look and the delivery's claim, acknowledgement, retry and set-aside — over the book of the
 * concrete store: its second layer.
 */
export abstract class InMemoryPauseQueryRepository extends InMemoryPausedRunRepository {
  protected abstract readonly book: InMemoryPauseBook;

  noticeOnceByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    kind: PauseNoticeKind,
    facts: PauseNoticeFacts,
    at: Date,
    recipients: PauseRecipients,
  ): Promise<boolean> {
    return Promise.resolve(
      this.book.noticeOnce(tenantId, pauseId, { kind, facts, at, recipients }),
    );
  }

  async findPendingByExpiresAtBefore(
    at: Date,
    limit: number,
    after?: PauseScanAfter,
  ): Promise<readonly PauseRecord[]> {
    assertScanLimit(limit);
    const due = this.pauses().flatMap((pause): Timed[] => {
      const time = pause.expiresAt;
      return pause.status === PauseStatus.Pending &&
        time !== undefined &&
        isAtOrBefore(time, at) &&
        (after === undefined || isPast(after, time, pause))
        ? [{ time, pause }]
        : [];
    });
    return Promise.resolve(firstByTime(due, limit).map(copiedPause));
  }

  async findPendingByRemindAtBefore(
    at: Date,
    limit: number,
    after?: PauseScanAfter,
  ): Promise<readonly PauseRecord[]> {
    assertScanLimit(limit);
    const due = this.pauses().flatMap((pause): Timed[] => {
      const time = pause.remindAt;
      return pause.status === PauseStatus.Pending &&
        time !== undefined &&
        isAtOrBefore(time, at) &&
        (after === undefined || isPast(after, time, pause))
        ? [{ time, pause }]
        : [];
    });
    return Promise.resolve(firstByTime(due, limit).map(copiedPause));
  }

  async findPendingUnsentReassignedBefore(
    cutoff: Date,
    limit: number,
    after?: PauseScanAfter,
  ): Promise<readonly PauseRecord[]> {
    assertScanLimit(limit);
    const unsent = this.pauses().flatMap((pause): Timed[] =>
      pause.status === PauseStatus.Pending &&
      !pause.isSent &&
      pause.reassignedFrom !== undefined &&
      isBefore(pause.askedAt, cutoff) &&
      (after === undefined || isPast(after, pause.askedAt, pause))
        ? [{ time: pause.askedAt, pause }]
        : [],
    );
    return Promise.resolve(firstByTime(unsent, limit).map(copiedPause));
  }

  async findOpenAfter(after: string | undefined, limit: number): Promise<PausePage> {
    assertScanLimit(limit);
    return Promise.resolve(this.#pageAfter(after, limit, ({ pause }) => isOpen(pause)));
  }

  async findPageByTenantId(
    tenantId: string,
    filter: PauseFilter,
    limit: number,
    after?: string,
  ): Promise<PausePage> {
    assertListing(filter, limit);
    return Promise.resolve(this.#pageAfter(after, limit, inScope(filter, tenantId)));
  }

  async findPageOfAllTenants(
    filter: PauseFilter,
    limit: number,
    after?: string,
  ): Promise<PausePage> {
    assertListing(filter, limit);
    return Promise.resolve(this.#pageAfter(after, limit, inScope(filter)));
  }

  async findClosedByResolvedAtBefore(
    cutoff: Date,
    limit: number,
    after?: string,
  ): Promise<PausePage> {
    assertScanLimit(limit);
    const isRemovable = this.#removableAt(cutoff);
    return Promise.resolve(this.#pageAfter(after, limit, ({ pause }) => isRemovable(pause)));
  }

  deleteByResolvedAtBefore(cutoff: Date): Promise<void> {
    this.book.remove(this.#removable(cutoff));
    return Promise.resolve();
  }

  async claimNoticesDue(
    at: Date,
    limit: number,
    claimFor: Milliseconds,
    recipients: readonly string[],
  ): Promise<readonly PauseNoticeClaim[]> {
    assertScanLimit(limit);
    return Promise.resolve(this.book.claim(at, limit, claimFor, recipients));
  }

  ackNotice(claim: PauseNoticeClaim, at: Date): Promise<PauseNoticeClaim | undefined> {
    return Promise.resolve(this.book.ack(claim, at));
  }

  renewNotice(
    claim: PauseNoticeClaim,
    at: Date,
    claimFor: Milliseconds,
  ): Promise<PauseNoticeClaim | undefined> {
    return Promise.resolve(this.book.renew(claim, at, claimFor));
  }

  retryNotice(claim: PauseNoticeClaim, nextAttemptAt: Date, problem: string): Promise<boolean> {
    return Promise.resolve(this.book.retry(claim, nextAttemptAt, problem));
  }

  setAsideNotices(claim: PauseNoticeClaim, _at: Date, problem: string): Promise<boolean> {
    return Promise.resolve(this.book.setAside(claim, problem));
  }

  async setAsideStaleNoticesBefore(
    writtenBefore: Date,
    at: Date,
    problem: string,
    limit: number,
  ): Promise<readonly SetAsideMailbox[]> {
    assertScanLimit(limit);
    return Promise.resolve(this.book.setAsideStale(writtenBefore, at, problem, limit));
  }

  countNotices(): Promise<PauseNoticeCounts> {
    return Promise.resolve(this.book.count());
  }

  protected pauses(): PauseRecord[] {
    return this.book.all().map(({ pause }) => pause);
  }

  /** What the retention removes: closed before `cutoff`, no live mailbox. */
  #removable(cutoff: Date): PauseRecord[] {
    const isRemovable = this.#removableAt(cutoff);
    return this.pauses().filter(isRemovable);
  }

  /** Whether a pause is closed before `cutoff`, with no live mailbox and no replacement of it still stored (#946). */
  #removableAt(cutoff: Date): (pause: PauseRecord) => boolean {
    const keyOf = (tenantId: string, pauseId: string | undefined): string =>
      JSON.stringify([tenantId, pauseId]);
    const stored = new Set(this.pauses().map((one) => keyOf(one.tenantId, one.pauseId)));
    return (pause) =>
      isExpiredPause(pause, cutoff) &&
      !this.book.hasLiveMailbox(pause) &&
      !stored.has(keyOf(pause.tenantId, pause.reassignedTo));
  }

  /** The first page, after the cursor, of the pauses `wanted` selects, in insertion order. */
  #pageAfter(
    after: string | undefined,
    limit: number,
    wanted: (entry: SequencedPause) => boolean,
  ): PausePage {
    const from = seqOfCursor(after);
    const page = pageOf(
      this.book.all().filter((entry) => entry.seq > from && wanted(entry)),
      limit,
    );
    return { ...page, pauses: page.pauses.map(copiedPause) };
  }
}
