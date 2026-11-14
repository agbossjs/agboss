import type { PausedExecution } from "../../app/paused-runs.js";
import { Injectable } from "../../components/decorators.js";
import { Clock } from "../clock.js";
import { PausedExecutionRepository } from "../paused-execution.repository.js";
import type {
  PauseNoticeClaim,
  PauseNoticeCounts,
  PausePage,
  PauseScanAfter,
  SetAsideMailbox,
} from "../pause-notices.js";
import type { PauseRecord } from "../pause-record.js";
import { SqliteConnection, sqliteImplementation } from "./sqlite-connection.js";
import { preparePauseTables } from "./sqlite-pause-schema.js";
import { SqlitePauseStore } from "./sqlite-pause-store.js";

/**
 * `PausedExecutionRepository` on the application's SQLite file (#265 S32, #267 S35, #910): one row
 * per thread of a tenant (#261) — the paused run and the versions it paused under —, one row per
 * pause (`pauses`) and one row per pause and receiver (`pause_notices`, the notices). The tables are
 * made at construction; every change of a pause is one `BEGIN IMMEDIATE` transaction with its
 * notices (`sqlite-pause-store.ts`): of two resumes on two instances exactly one records its
 * decision, and a notice is never without its change nor a change without its notice. With
 * `SqliteCheckpointSaver` a pause survives a restart. Listed in `@Application({ providers })`;
 * needs `sqlitePath`. It holds the store privately and delegates every method to it (#895): the
 * store's layers and helpers are no public API.
 */
@Injectable({ deps: [SqliteConnection, Clock] })
export class SqlitePausedExecutionRepository extends PausedExecutionRepository {
  readonly #store: SqlitePauseStore;

  constructor(connection: SqliteConnection, clock: Clock) {
    super();
    this.#store = new SqlitePauseStore(connection, clock);
    preparePauseTables(connection);
  }

  ping(): Promise<void> {
    return this.#store.ping();
  }

  findByTenantIdAndThreadId(
    ...args: Parameters<PausedExecutionRepository["findByTenantIdAndThreadId"]>
  ): Promise<PausedExecution | undefined> {
    return this.#store.findByTenantIdAndThreadId(...args);
  }

  save(paused: PausedExecution): Promise<void> {
    return this.#store.save(paused);
  }

  deleteByTenantIdAndThreadId(tenantId: string, threadId: string): Promise<void> {
    return this.#store.deleteByTenantIdAndThreadId(tenantId, threadId);
  }

  findOrCreateByStepKey(pause: PauseRecord): Promise<PauseRecord> {
    return this.#store.findOrCreateByStepKey(pause);
  }

  findByTenantIdAndPauseId(tenantId: string, pauseId: string): Promise<PauseRecord | undefined> {
    return this.#store.findByTenantIdAndPauseId(tenantId, pauseId);
  }

  findAllByTenantIdAndRootExecutionId(
    ...args: Parameters<PausedExecutionRepository["findAllByTenantIdAndRootExecutionId"]>
  ): Promise<readonly PauseRecord[]> {
    return this.#store.findAllByTenantIdAndRootExecutionId(...args);
  }

  markSentByTenantIdAndPauseId(
    ...args: Parameters<PausedExecutionRepository["markSentByTenantIdAndPauseId"]>
  ): Promise<boolean> {
    return this.#store.markSentByTenantIdAndPauseId(...args);
  }

  resolveByTenantIdAndPauseId(
    ...args: Parameters<PausedExecutionRepository["resolveByTenantIdAndPauseId"]>
  ): Promise<PauseRecord | undefined> {
    return this.#store.resolveByTenantIdAndPauseId(...args);
  }

  decideByTenantIdAndPauseId(
    ...args: Parameters<PausedExecutionRepository["decideByTenantIdAndPauseId"]>
  ): Promise<boolean> {
    return this.#store.decideByTenantIdAndPauseId(...args);
  }

  cancelByTenantIdAndPauseId(
    ...args: Parameters<PausedExecutionRepository["cancelByTenantIdAndPauseId"]>
  ): Promise<PauseRecord | undefined> {
    return this.#store.cancelByTenantIdAndPauseId(...args);
  }

  expireByTenantIdAndPauseId(
    ...args: Parameters<PausedExecutionRepository["expireByTenantIdAndPauseId"]>
  ): Promise<PauseRecord | undefined> {
    return this.#store.expireByTenantIdAndPauseId(...args);
  }

  closeUntakenByTenantIdAndPauseId(
    ...args: Parameters<PausedExecutionRepository["closeUntakenByTenantIdAndPauseId"]>
  ): Promise<PauseRecord | undefined> {
    return this.#store.closeUntakenByTenantIdAndPauseId(...args);
  }

  extendByTenantIdAndPauseId(
    ...args: Parameters<PausedExecutionRepository["extendByTenantIdAndPauseId"]>
  ): Promise<PauseRecord | undefined> {
    return this.#store.extendByTenantIdAndPauseId(...args);
  }

  remindByTenantIdAndPauseId(
    ...args: Parameters<PausedExecutionRepository["remindByTenantIdAndPauseId"]>
  ): Promise<boolean> {
    return this.#store.remindByTenantIdAndPauseId(...args);
  }

  noticeOnceByTenantIdAndPauseId(
    ...args: Parameters<PausedExecutionRepository["noticeOnceByTenantIdAndPauseId"]>
  ): Promise<boolean> {
    return this.#store.noticeOnceByTenantIdAndPauseId(...args);
  }

  markTakenByTenantIdAndPauseId(tenantId: string, pauseId: string): Promise<void> {
    return this.#store.markTakenByTenantIdAndPauseId(tenantId, pauseId);
  }

  findByTenantIdAndRootExecutionIdAndStepKey(
    ...args: Parameters<PausedExecutionRepository["findByTenantIdAndRootExecutionIdAndStepKey"]>
  ): Promise<PauseRecord | undefined> {
    return this.#store.findByTenantIdAndRootExecutionIdAndStepKey(...args);
  }

  findPendingByExpiresAtBefore(
    at: Date,
    limit: number,
    after?: PauseScanAfter,
  ): Promise<readonly PauseRecord[]> {
    return this.#store.findPendingByExpiresAtBefore(at, limit, after);
  }

  findPendingByRemindAtBefore(at: Date, limit: number): Promise<readonly PauseRecord[]> {
    return this.#store.findPendingByRemindAtBefore(at, limit);
  }

  findOpenAfter(after: string | undefined, limit: number): Promise<PausePage> {
    return this.#store.findOpenAfter(after, limit);
  }

  findPageByTenantId(
    ...args: Parameters<PausedExecutionRepository["findPageByTenantId"]>
  ): Promise<PausePage> {
    return this.#store.findPageByTenantId(...args);
  }

  findClosedByResolvedAtBefore(cutoff: Date, limit: number, after?: string): Promise<PausePage> {
    return this.#store.findClosedByResolvedAtBefore(cutoff, limit, after);
  }

  deleteByResolvedAtBefore(cutoff: Date): Promise<void> {
    return this.#store.deleteByResolvedAtBefore(cutoff);
  }

  claimNoticesDue(
    ...args: Parameters<PausedExecutionRepository["claimNoticesDue"]>
  ): Promise<readonly PauseNoticeClaim[]> {
    return this.#store.claimNoticesDue(...args);
  }

  ackNotice(claim: PauseNoticeClaim, at: Date): Promise<PauseNoticeClaim | undefined> {
    return this.#store.ackNotice(claim, at);
  }

  retryNotice(claim: PauseNoticeClaim, nextAttemptAt: Date, problem: string): Promise<boolean> {
    return this.#store.retryNotice(claim, nextAttemptAt, problem);
  }

  setAsideNotices(claim: PauseNoticeClaim, at: Date, problem: string): Promise<boolean> {
    return this.#store.setAsideNotices(claim, at, problem);
  }

  setAsideStaleNoticesBefore(
    ...args: Parameters<PausedExecutionRepository["setAsideStaleNoticesBefore"]>
  ): Promise<readonly SetAsideMailbox[]> {
    return this.#store.setAsideStaleNoticesBefore(...args);
  }

  countNotices(): Promise<PauseNoticeCounts> {
    return this.#store.countNotices();
  }

  deleteByTenantIdAndThreadIdAndRunId(
    ...args: Parameters<PausedExecutionRepository["deleteByTenantIdAndThreadIdAndRunId"]>
  ): Promise<void> {
    return this.#store.deleteByTenantIdAndThreadIdAndRunId(...args);
  }
}

sqliteImplementation(SqlitePausedExecutionRepository);
