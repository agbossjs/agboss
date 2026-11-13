import type { Milliseconds } from "../units/index.js";
import type { InMemoryPauseBook } from "./in-memory-pause-book.js";
import { InMemoryPausedRunRepository } from "./in-memory-paused-runs.js";
import type {
  PauseFilter,
  PauseNoticeClaim,
  PauseNoticeCounts,
  PauseNoticeFacts,
  PauseNoticeKind,
  PausePage,
  PauseRecipients,
  SetAsideMailbox,
} from "./pause-notices.js";
import { isExpiredPause, PauseStatus, type PauseRecord } from "./pause-record.js";
import {
  assertPauseFilter,
  compareText,
  assertScanLimit,
  matchesFilter,
  pageOf,
  seqOfCursor,
  type SequencedPause,
} from "./pause-scans.js";

/** Pauses ordered by the time at `field`, then tenant and id: the deadline scans' order. */
const byTimeOf =
  (field: "expiresAt" | "remindAt") =>
  (a: PauseRecord, b: PauseRecord): number =>
    compareText(a[field] ?? "", b[field] ?? "") ||
    compareText(a.tenantId, b.tenantId) ||
    compareText(a.pauseId, b.pauseId);

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

  async findPendingByExpiresAtBefore(at: Date, limit: number): Promise<readonly PauseRecord[]> {
    assertScanLimit(limit);
    const due = this.pauses().filter(
      (pause) =>
        pause.status === PauseStatus.Pending &&
        pause.expiresAt !== undefined &&
        pause.expiresAt <= at.toISOString(),
    );
    return Promise.resolve(due.sort(byTimeOf("expiresAt")).slice(0, limit));
  }

  async findPendingByRemindAtBefore(at: Date, limit: number): Promise<readonly PauseRecord[]> {
    assertScanLimit(limit);
    const due = this.pauses().filter(
      (pause) =>
        pause.status === PauseStatus.Pending &&
        pause.remindAt !== undefined &&
        pause.remindAt <= at.toISOString(),
    );
    return Promise.resolve(due.sort(byTimeOf("remindAt")).slice(0, limit));
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
    assertScanLimit(limit);
    assertPauseFilter(filter);
    return Promise.resolve(
      this.#pageAfter(
        after,
        limit,
        ({ pause }) => pause.tenantId === tenantId && matchesFilter(pause, filter),
      ),
    );
  }

  async findClosedByResolvedAtBefore(cutoff: Date, limit: number): Promise<readonly PauseRecord[]> {
    assertScanLimit(limit);
    return Promise.resolve(this.#removable(cutoff).slice(0, limit));
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
    return this.pauses().filter(
      (pause) => isExpiredPause(pause, cutoff) && !this.book.hasLiveMailbox(pause),
    );
  }

  /** The first page, after the cursor, of the pauses `wanted` selects, in insertion order. */
  #pageAfter(
    after: string | undefined,
    limit: number,
    wanted: (entry: SequencedPause) => boolean,
  ): PausePage {
    const from = seqOfCursor(after);
    return pageOf(
      this.book.all().filter((entry) => entry.seq > from && wanted(entry)),
      limit,
    );
  }
}
