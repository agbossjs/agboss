import { randomBytes } from "node:crypto";
import type { Milliseconds } from "../../units/index.js";
import type {
  PauseFilter,
  PauseNoticeClaim,
  PauseNoticeCounts,
  PausePage,
  SetAsideMailbox,
} from "../pause-notices.js";
import type { PauseRecord } from "../pause-record.js";
import { assertPauseFilter, assertScanLimit, seqOfCursor } from "../pause-scans.js";
import { SqlitePausedRunRepository } from "./sqlite-paused-runs.repository.js";

/**
 * The second layer of `SqlitePausedExecutionRepository`: the scans, the retention's look and
 * delete, and the delivery of notices — each one step of its own transaction.
 */
export abstract class SqlitePauseQueryRepository extends SqlitePausedRunRepository {
  async findPendingByExpiresAtBefore(at: Date, limit: number): Promise<readonly PauseRecord[]> {
    assertScanLimit(limit);
    return Promise.resolve(this.scans.pendingDue("expires_at", at, limit));
  }

  async findPendingByRemindAtBefore(at: Date, limit: number): Promise<readonly PauseRecord[]> {
    assertScanLimit(limit);
    return Promise.resolve(this.scans.pendingDue("remind_at", at, limit));
  }

  async findOpenAfter(after: string | undefined, limit: number): Promise<PausePage> {
    assertScanLimit(limit);
    return Promise.resolve(this.scans.open(seqOfCursor(after), limit));
  }

  async findPageByTenantId(
    tenantId: string,
    filter: PauseFilter,
    limit: number,
    after?: string,
  ): Promise<PausePage> {
    assertScanLimit(limit);
    assertPauseFilter(filter);
    return Promise.resolve(this.scans.ofTenant(tenantId, filter, seqOfCursor(after), limit));
  }

  async findClosedByResolvedAtBefore(cutoff: Date, limit: number): Promise<readonly PauseRecord[]> {
    assertScanLimit(limit);
    return Promise.resolve(this.scans.closedBefore(cutoff, limit));
  }

  deleteByResolvedAtBefore(cutoff: Date): Promise<void> {
    this.connection.transaction(() => {
      this.scans.removeClosedBefore(cutoff);
    });
    return Promise.resolve();
  }

  async claimNoticesDue(
    at: Date,
    limit: number,
    claimFor: Milliseconds,
    recipients: readonly string[],
  ): Promise<readonly PauseNoticeClaim[]> {
    assertScanLimit(limit);
    const claims = this.connection.transaction(() =>
      this.notices.claimDue(at, limit, claimFor, recipients, () => randomBytes(16).toString("hex")),
    );
    return Promise.resolve(claims);
  }

  ackNotice(claim: PauseNoticeClaim, at: Date): Promise<PauseNoticeClaim | undefined> {
    return Promise.resolve(this.connection.transaction(() => this.notices.ack(claim, at)));
  }

  retryNotice(claim: PauseNoticeClaim, nextAttemptAt: Date, problem: string): Promise<boolean> {
    return Promise.resolve(
      this.connection.transaction(() => this.notices.retry(claim, nextAttemptAt, problem)),
    );
  }

  setAsideNotices(claim: PauseNoticeClaim, _at: Date, problem: string): Promise<boolean> {
    return Promise.resolve(
      this.connection.transaction(() => this.notices.setAside(claim, problem)),
    );
  }

  async setAsideStaleNoticesBefore(
    writtenBefore: Date,
    at: Date,
    problem: string,
    limit: number,
  ): Promise<readonly SetAsideMailbox[]> {
    assertScanLimit(limit);
    return Promise.resolve(
      this.connection.transaction(() =>
        this.notices.setAsideStale(writtenBefore, at, problem, limit),
      ),
    );
  }

  countNotices(): Promise<PauseNoticeCounts> {
    return Promise.resolve(this.notices.count());
  }
}
