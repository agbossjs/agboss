import { MemorySaver } from "@langchain/langgraph";
import type { PausedExecution } from "../../src/app/paused-runs.js";
import { Injectable } from "../../src/components/decorators.js";
import { TurnStoreRecordRepository } from "../../src/infrastructure/execution-record.repository.js";
import { InMemoryPausedExecutionRepository } from "../../src/infrastructure/in-memory-paused-execution.repository.js";
import {
  PausedExecutionRepository,
  type PauseRecord,
  type PauseAnswer,
  type PauseCancellation,
} from "../../src/infrastructure/paused-execution.repository.js";
import { createSqliteTurnStore, type TurnStore } from "../../src/turns/index.js";

/**
 * Durable infrastructure for the tests of restarts and deployments (#261): an application lists
 * these in `@Application({ providers })` like any implementation of a contract, and every app
 * instance of a test reads the same "database" — what a real durable store (SQLite, #265) gives.
 * `resetSharedDatabase()` empties it between tests.
 */
interface SharedDatabase {
  readonly checkpoints: MemorySaver;
  readonly paused: Map<string, PausedExecution>;
  /** The pauses of every paused run: one store every instance reads. */
  pauses: InMemoryPausedExecutionRepository;
  records: TurnStore;
}

const database: SharedDatabase = {
  checkpoints: new MemorySaver(),
  paused: new Map(),
  pauses: new InMemoryPausedExecutionRepository(),
  records: createSqliteTurnStore(":memory:", () => new Date()),
};

/** Empties the shared database (each test starts with none). */
export function resetSharedDatabase(): void {
  database.checkpoints.storage = {};
  database.checkpoints.writes = {};
  database.paused.clear();
  database.pauses = new InMemoryPausedExecutionRepository();
  database.records.close();
  database.records = createSqliteTurnStore(":memory:", () => new Date());
}

/** The paused executions in the shared database. */
/** One key per thread of a tenant (#261: the same id in two tenants is two threads). */
const keyOf = (tenantId: string, threadId: string): string => `${tenantId}/${threadId}`;

/** The paused run the shared database keeps for a thread (of the tenant `"default"`). */
export const sharedPausedRun = (
  threadId: string,
  tenantId = "default",
): PausedExecution | undefined => database.paused.get(keyOf(tenantId, threadId));

/** Checkpoints in the shared database: every instance reads the same storage. */
@Injectable()
export class SharedCheckpointSaver extends MemorySaver {
  constructor() {
    super();
    this.storage = database.checkpoints.storage;
    this.writes = database.checkpoints.writes;
  }
}

/** The arguments of a pause store's method: what the shared store hands on unchanged. */
type Args<K extends keyof PausedExecutionRepository> = Parameters<PausedExecutionRepository[K]>;

@Injectable()
export class SharedPausedExecutionRepository extends PausedExecutionRepository {
  ping(): Promise<void> {
    return Promise.resolve();
  }

  findByTenantIdAndThreadId(
    tenantId: string,
    threadId: string,
  ): Promise<PausedExecution | undefined> {
    return Promise.resolve(database.paused.get(keyOf(tenantId, threadId)));
  }

  save(paused: PausedExecution): Promise<void> {
    database.paused.set(keyOf(paused.run.tenantId, paused.run.threadId), paused);
    return Promise.resolve();
  }

  deleteByTenantIdAndThreadId(tenantId: string, threadId: string): Promise<void> {
    database.paused.delete(keyOf(tenantId, threadId));
    return Promise.resolve();
  }

  findOrCreateByStepKey(
    ...args: Args<"findOrCreateByStepKey">
  ): ReturnType<PausedExecutionRepository["findOrCreateByStepKey"]> {
    return database.pauses.findOrCreateByStepKey(...args);
  }

  findByTenantIdAndRootExecutionIdAndStepKey(
    ...args: Args<"findByTenantIdAndRootExecutionIdAndStepKey">
  ): ReturnType<PausedExecutionRepository["findByTenantIdAndRootExecutionIdAndStepKey"]> {
    return database.pauses.findByTenantIdAndRootExecutionIdAndStepKey(...args);
  }

  findByTenantIdAndPauseId(
    ...args: Args<"findByTenantIdAndPauseId">
  ): ReturnType<PausedExecutionRepository["findByTenantIdAndPauseId"]> {
    return database.pauses.findByTenantIdAndPauseId(...args);
  }

  findAllByTenantIdAndRootExecutionId(
    ...args: Args<"findAllByTenantIdAndRootExecutionId">
  ): ReturnType<PausedExecutionRepository["findAllByTenantIdAndRootExecutionId"]> {
    return database.pauses.findAllByTenantIdAndRootExecutionId(...args);
  }

  markSentByTenantIdAndPauseId(
    ...args: Args<"markSentByTenantIdAndPauseId">
  ): ReturnType<PausedExecutionRepository["markSentByTenantIdAndPauseId"]> {
    return database.pauses.markSentByTenantIdAndPauseId(...args);
  }

  resolveByTenantIdAndPauseId(
    ...args: Args<"resolveByTenantIdAndPauseId">
  ): ReturnType<PausedExecutionRepository["resolveByTenantIdAndPauseId"]> {
    return database.pauses.resolveByTenantIdAndPauseId(...args);
  }

  decideByTenantIdAndPauseId(
    ...args: Args<"decideByTenantIdAndPauseId">
  ): ReturnType<PausedExecutionRepository["decideByTenantIdAndPauseId"]> {
    return database.pauses.decideByTenantIdAndPauseId(...args);
  }

  cancelByTenantIdAndPauseId(
    ...args: Args<"cancelByTenantIdAndPauseId">
  ): ReturnType<PausedExecutionRepository["cancelByTenantIdAndPauseId"]> {
    return database.pauses.cancelByTenantIdAndPauseId(...args);
  }

  expireByTenantIdAndPauseId(
    ...args: Args<"expireByTenantIdAndPauseId">
  ): ReturnType<PausedExecutionRepository["expireByTenantIdAndPauseId"]> {
    return database.pauses.expireByTenantIdAndPauseId(...args);
  }

  closeUntakenByTenantIdAndPauseId(
    ...args: Args<"closeUntakenByTenantIdAndPauseId">
  ): ReturnType<PausedExecutionRepository["closeUntakenByTenantIdAndPauseId"]> {
    return database.pauses.closeUntakenByTenantIdAndPauseId(...args);
  }

  extendByTenantIdAndPauseId(
    ...args: Args<"extendByTenantIdAndPauseId">
  ): ReturnType<PausedExecutionRepository["extendByTenantIdAndPauseId"]> {
    return database.pauses.extendByTenantIdAndPauseId(...args);
  }

  remindByTenantIdAndPauseId(
    ...args: Args<"remindByTenantIdAndPauseId">
  ): ReturnType<PausedExecutionRepository["remindByTenantIdAndPauseId"]> {
    return database.pauses.remindByTenantIdAndPauseId(...args);
  }

  noticeOnceByTenantIdAndPauseId(
    ...args: Args<"noticeOnceByTenantIdAndPauseId">
  ): ReturnType<PausedExecutionRepository["noticeOnceByTenantIdAndPauseId"]> {
    return database.pauses.noticeOnceByTenantIdAndPauseId(...args);
  }

  markTakenByTenantIdAndPauseId(
    ...args: Args<"markTakenByTenantIdAndPauseId">
  ): ReturnType<PausedExecutionRepository["markTakenByTenantIdAndPauseId"]> {
    return database.pauses.markTakenByTenantIdAndPauseId(...args);
  }

  findPendingByExpiresAtBefore(
    ...args: Args<"findPendingByExpiresAtBefore">
  ): ReturnType<PausedExecutionRepository["findPendingByExpiresAtBefore"]> {
    return database.pauses.findPendingByExpiresAtBefore(...args);
  }

  findPendingByRemindAtBefore(
    ...args: Args<"findPendingByRemindAtBefore">
  ): ReturnType<PausedExecutionRepository["findPendingByRemindAtBefore"]> {
    return database.pauses.findPendingByRemindAtBefore(...args);
  }

  findOpenAfter(
    ...args: Args<"findOpenAfter">
  ): ReturnType<PausedExecutionRepository["findOpenAfter"]> {
    return database.pauses.findOpenAfter(...args);
  }

  findPageByTenantId(
    ...args: Args<"findPageByTenantId">
  ): ReturnType<PausedExecutionRepository["findPageByTenantId"]> {
    return database.pauses.findPageByTenantId(...args);
  }

  findClosedByResolvedAtBefore(
    ...args: Args<"findClosedByResolvedAtBefore">
  ): ReturnType<PausedExecutionRepository["findClosedByResolvedAtBefore"]> {
    return database.pauses.findClosedByResolvedAtBefore(...args);
  }

  deleteByResolvedAtBefore(
    ...args: Args<"deleteByResolvedAtBefore">
  ): ReturnType<PausedExecutionRepository["deleteByResolvedAtBefore"]> {
    return database.pauses.deleteByResolvedAtBefore(...args);
  }

  claimNoticesDue(
    ...args: Args<"claimNoticesDue">
  ): ReturnType<PausedExecutionRepository["claimNoticesDue"]> {
    return database.pauses.claimNoticesDue(...args);
  }

  ackNotice(...args: Args<"ackNotice">): ReturnType<PausedExecutionRepository["ackNotice"]> {
    return database.pauses.ackNotice(...args);
  }

  retryNotice(...args: Args<"retryNotice">): ReturnType<PausedExecutionRepository["retryNotice"]> {
    return database.pauses.retryNotice(...args);
  }

  setAsideNotices(
    ...args: Args<"setAsideNotices">
  ): ReturnType<PausedExecutionRepository["setAsideNotices"]> {
    return database.pauses.setAsideNotices(...args);
  }

  setAsideStaleNoticesBefore(
    ...args: Args<"setAsideStaleNoticesBefore">
  ): ReturnType<PausedExecutionRepository["setAsideStaleNoticesBefore"]> {
    return database.pauses.setAsideStaleNoticesBefore(...args);
  }

  countNotices(
    ...args: Args<"countNotices">
  ): ReturnType<PausedExecutionRepository["countNotices"]> {
    return database.pauses.countNotices(...args);
  }

  deleteByTenantIdAndThreadIdAndRunId(
    tenantId: string,
    threadId: string,
    runId: string,
  ): Promise<void> {
    const key = keyOf(tenantId, threadId);
    if (database.paused.get(key)?.run.runId === runId) database.paused.delete(key);
    return Promise.resolve();
  }
}

@Injectable()
export class SharedExecutionRecordRepository extends TurnStoreRecordRepository {
  constructor() {
    super(database.records);
  }
}
