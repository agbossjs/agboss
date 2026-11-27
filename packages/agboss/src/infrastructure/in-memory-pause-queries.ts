import type { Milliseconds } from "../units/index.js";
import { isAtOrBefore, isBefore } from "./instants.js";
import { stepOf } from "./in-memory-step.js";
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
  assertScanLimit,
  firstByTime,
  inScope,
  isPast,
  pageOf,
  seqOfCursor,
  type SequencedPause,
  type Timed,
} from "./pause-scans.js";

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
    return stepOf(() => this.book.noticeOnce(tenantId, pauseId, { kind, facts, at, recipients }));
  }

  async findPendingByExpiresAtBefore(
    at: Date,
    limit: number,
    after?: PauseScanAfter,
  ): Promise<readonly PauseRecord[]> {
    return Promise.resolve(this.#dueBy("expiresAt", at, limit, after));
  }

  async findPendingByRemindAtBefore(
    at: Date,
    limit: number,
    after?: PauseScanAfter,
  ): Promise<readonly PauseRecord[]> {
    return Promise.resolve(this.#dueBy("remindAt", at, limit, after));
  }

  /** The first `limit` pending pauses whose `column` time is at or before `at`, past the keyset `after`. */
  #dueBy(
    column: "expiresAt" | "remindAt",
    at: Date,
    limit: number,
    after: PauseScanAfter | undefined,
  ): readonly PauseRecord[] {
    assertScanLimit(limit);
    const due = this.pauses().flatMap((pause): Timed[] => {
      const time = pause[column];
      return pause.status === PauseStatus.Pending &&
        time !== undefined &&
        isAtOrBefore(time, at) &&
        (after === undefined || isPast(after, time, pause))
        ? [{ time, pause }]
        : [];
    });
    return firstByTime(due, limit).map(copiedPause);
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
    return Promise.resolve(
      this.#pageAfter(
        after,
        limit,
        ({ pause }) =>
          pause.status === PauseStatus.Pending || pause.status === PauseStatus.Resolved,
      ),
    );
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

  async ackNotice(claim: PauseNoticeClaim, at: Date): Promise<PauseNoticeClaim | undefined> {
    return Promise.resolve(this.book.ack(claim, at));
  }

  async renewNotice(
    claim: PauseNoticeClaim,
    at: Date,
    claimFor: Milliseconds,
  ): Promise<PauseNoticeClaim | undefined> {
    return Promise.resolve(this.book.renew(claim, at, claimFor));
  }

  async retryNotice(claim: PauseNoticeClaim, retryAt: Date, problem: string): Promise<boolean> {
    return Promise.resolve(this.book.retry(claim, retryAt, problem));
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
