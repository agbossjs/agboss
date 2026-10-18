import { MemorySaver } from "@langchain/langgraph";
import type { PausedRun } from "../../src/app/paused-runs.js";
import { Injectable } from "../../src/components/decorators.js";
import { TernStoreRecordRepository } from "../../src/infrastructure/execution-record.repository.js";
import {
  PausedExecutionRepository,
  PauseStatus,
  resolvedPause,
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
  readonly paused: Map<string, PausedRun>;
  records: TernStore;
}

const database: SharedDatabase = {
  checkpoints: new MemorySaver(),
  paused: new Map(),
  records: createSqliteTernStore(":memory:"),
};

/** Empties the shared database (each test starts with none). */
export function resetSharedDatabase(): void {
  database.checkpoints.storage = {};
  database.checkpoints.writes = {};
  database.paused.clear();
  database.records.close();
  database.records = createSqliteTernStore(":memory:");
}

/** The paused executions in the shared database. */
export const sharedPausedRuns = (): ReadonlyMap<string, PausedRun> => database.paused;

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
  findByThreadId(threadId: string): Promise<PausedRun | undefined> {
    return Promise.resolve(database.paused.get(threadId));
  }

  save(paused: PausedRun): Promise<void> {
    database.paused.set(paused.run.threadId, paused);
    return Promise.resolve();
  }

  resolveByThreadId(threadId: string, decision: unknown): Promise<PausedRun | undefined> {
    const stored = database.paused.get(threadId);
    if (stored?.status !== PauseStatus.Pending) return Promise.resolve(undefined);
    const resolved = resolvedPause(stored, decision);
    database.paused.set(threadId, resolved);
    return Promise.resolve(resolved);
  }

  deleteByThreadId(threadId: string): Promise<void> {
    database.paused.delete(threadId);
    return Promise.resolve();
  }
}

@Injectable()
export class SharedExecutionRecordRepository extends TernStoreRecordRepository {
  constructor() {
    super(database.records);
  }
}
