import { MemorySaver } from "@langchain/langgraph";
import type { PausedExecution } from "../../src/app/paused-runs.js";
import { Injectable } from "../../src/components/decorators.js";
import { TernStoreRecordRepository } from "../../src/infrastructure/execution-record.repository.js";
import {
  InMemoryPausedExecutionRepository,
  PausedExecutionRepository,
  type PauseRecord,
  type PauseAnswer,
  type PauseCancellation,
} from "../../src/infrastructure/paused-execution.repository.js";
import { createSqliteTernStore, type TernStore } from "../../src/terns/index.js";

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
  records: TernStore;
}

const database: SharedDatabase = {
  checkpoints: new MemorySaver(),
  paused: new Map(),
  pauses: new InMemoryPausedExecutionRepository(),
  records: createSqliteTernStore(":memory:", () => new Date()),
};

/** Empties the shared database (each test starts with none). */
export function resetSharedDatabase(): void {
  database.checkpoints.storage = {};
  database.checkpoints.writes = {};
  database.paused.clear();
  database.pauses = new InMemoryPausedExecutionRepository();
  database.records.close();
  database.records = createSqliteTernStore(":memory:", () => new Date());
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

  findOrCreateByStepKey(pause: PauseRecord): Promise<PauseRecord> {
    return database.pauses.findOrCreateByStepKey(pause);
  }

  findByTenantIdAndPauseId(tenantId: string, pauseId: string): Promise<PauseRecord | undefined> {
    return database.pauses.findByTenantIdAndPauseId(tenantId, pauseId);
  }

  findAllByTenantIdAndRootExecutionId(
    tenantId: string,
    rootExecutionId: string,
  ): Promise<readonly PauseRecord[]> {
    return database.pauses.findAllByTenantIdAndRootExecutionId(tenantId, rootExecutionId);
  }

  markSentByTenantIdAndPauseId(tenantId: string, pauseId: string): Promise<boolean> {
    return database.pauses.markSentByTenantIdAndPauseId(tenantId, pauseId);
  }

  resolveByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    answer: PauseAnswer,
    at: Date,
  ): Promise<PauseRecord | undefined> {
    return database.pauses.resolveByTenantIdAndPauseId(tenantId, pauseId, answer, at);
  }

  decideByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    answer: PauseAnswer,
    at: Date,
  ): Promise<boolean> {
    return database.pauses.decideByTenantIdAndPauseId(tenantId, pauseId, answer, at);
  }

  cancelByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    resolution: PauseCancellation,
    at: Date,
  ): Promise<boolean> {
    return database.pauses.cancelByTenantIdAndPauseId(tenantId, pauseId, resolution, at);
  }

  markTakenByTenantIdAndPauseId(tenantId: string, pauseId: string): Promise<void> {
    return database.pauses.markTakenByTenantIdAndPauseId(tenantId, pauseId);
  }

  deleteResolvedBefore(cutoff: Date): Promise<void> {
    return database.pauses.deleteResolvedBefore(cutoff);
  }
}

@Injectable()
export class SharedExecutionRecordRepository extends TernStoreRecordRepository {
  constructor() {
    super(database.records);
  }
}
