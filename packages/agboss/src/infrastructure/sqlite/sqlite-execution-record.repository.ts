import { Injectable } from "../../components/decorators.js";
import { ApplicationContext } from "../../flow/context/application-context.js";
import type { PauseAnswerRecord } from "../../flow/runtime/execution-record.js";
import {
  sharedTurnStore,
  type ConfigSnapshot,
  type NewSummary,
  type NewThread,
  type NewTurn,
  type Summary,
  type Turn,
  type TurnOutcome,
  type VersionScore,
} from "../../turns/index.js";
import { Clock, IdGenerator, mintedThreadIdsOf } from "../clock.js";
import {
  ExecutionRecordRepository,
  TurnStoreRecordRepository,
  type ExecutionRecordStatus,
} from "../execution-record.repository.js";
import { SqliteConnection, sqliteImplementation } from "./sqlite-connection.js";

/**
 * `ExecutionRecordRepository` on the application's SQLite file (#265, S32): threads, records,
 * scores, summaries and config snapshots in the Turn tables, migrated on first use — so
 * `agboss eval` / `replay` / `golden` and `--thread` see the records of earlier processes, and
 * recovery finds the roots a dead instance left `running`. Status writes that must not land late
 * are compare-and-set (`completeIfStatus`, one statement). A new thread's id comes from the
 * application's `IdGenerator` (#313). Listed in `@Application({ providers })`; needs `sqlitePath`.
 * A project subclasses it through public tokens only (#265 S70): `@Injectable({ deps:
 * [SqliteConnection, Clock, ApplicationContext, IdGenerator] })`, the same `deps` as this class.
 * It holds the Turn store privately and delegates every method to it (#895): the store's seam is
 * no public API.
 */
@Injectable({ deps: [SqliteConnection, Clock, ApplicationContext, IdGenerator] })
export class SqliteExecutionRecordRepository extends ExecutionRecordRepository {
  readonly #connection: SqliteConnection;
  readonly #records: TurnStoreRecordRepository;

  constructor(
    connection: SqliteConnection,
    clock: Clock,
    applicationContext: ApplicationContext,
    idGenerator: IdGenerator,
  ) {
    super();
    this.#connection = connection;
    this.#records = new TurnStoreRecordRepository(
      sharedTurnStore(connection.database, () => clock.now(), mintedThreadIdsOf(idGenerator)),
    );
  }

  ping(): Promise<void> {
    return this.#connection.ping();
  }

  createThread(thread: NewThread): Promise<string> {
    return this.#records.createThread(thread);
  }

  hasThread(workflow: string, tenantId: string, threadId: string): Promise<boolean> {
    return this.#records.hasThread(workflow, tenantId, threadId);
  }

  threadOwner(
    ...args: Parameters<ExecutionRecordRepository["threadOwner"]>
  ): Promise<{ readonly owner: string | undefined } | undefined> {
    return this.#records.threadOwner(...args);
  }

  append(turn: NewTurn): Promise<Turn> {
    return this.#records.append(turn);
  }

  complete(turnId: string, outcome: TurnOutcome): Promise<void> {
    return this.#records.complete(turnId, outcome);
  }

  completeIfStatus(
    ...args: Parameters<ExecutionRecordRepository["completeIfStatus"]>
  ): Promise<boolean> {
    return this.#records.completeIfStatus(...args);
  }

  lastTurns(tenantId: string, threadId: string, limit: number): Promise<Turn[]> {
    return this.#records.lastTurns(tenantId, threadId, limit);
  }

  byIds(ids: readonly string[]): Promise<Turn[]> {
    return this.#records.byIds(ids);
  }

  findByStatus(status: ExecutionRecordStatus, limit: number, after?: string): Promise<Turn[]> {
    return this.#records.findByStatus(status, limit, after);
  }

  findByTenantIdAndRunId(tenantId: string, runId: string): Promise<Turn | undefined> {
    return this.#records.findByTenantIdAndRunId(tenantId, runId);
  }

  byVersion(workflow: string, promptVersion: string, limit: number): Promise<Turn[]> {
    return this.#records.byVersion(workflow, promptVersion, limit);
  }

  unscored(workflow: string, promptVersion: string | undefined, limit: number): Promise<Turn[]> {
    return this.#records.unscored(workflow, promptVersion, limit);
  }

  saveScore(turnId: string, judge: string, score: number): Promise<void> {
    return this.#records.saveScore(turnId, judge, score);
  }

  meanScore(turnIds: readonly string[]): Promise<number | null> {
    return this.#records.meanScore(turnIds);
  }

  summary(workflow: string): Promise<VersionScore[]> {
    return this.#records.summary(workflow);
  }

  rememberConfig(
    ...args: Parameters<ExecutionRecordRepository["rememberConfig"]>
  ): Promise<{ readonly drift: boolean }> {
    return this.#records.rememberConfig(...args);
  }

  configSnapshots(workflow: string, version: string): Promise<ConfigSnapshot[]> {
    return this.#records.configSnapshots(workflow, version);
  }

  recentOriginals(workflow: string, limit: number): Promise<Turn[]> {
    return this.#records.recentOriginals(workflow, limit);
  }

  uncovered(tenantId: string, threadId: string, compaction: string): Promise<Turn[]> {
    return this.#records.uncovered(tenantId, threadId, compaction);
  }

  before(tenantId: string, threadId: string, turnId: string, limit: number): Promise<Turn[]> {
    return this.#records.before(tenantId, threadId, turnId, limit);
  }

  turnNumber(tenantId: string, threadId: string, turnId: string): Promise<number> {
    return this.#records.turnNumber(tenantId, threadId, turnId);
  }

  addSummary(summary: NewSummary): Promise<Summary> {
    return this.#records.addSummary(summary);
  }

  latestSummaries(
    ...args: Parameters<ExecutionRecordRepository["latestSummaries"]>
  ): Promise<Summary[]> {
    return this.#records.latestSummaries(...args);
  }

  summaryCount(tenantId: string, threadId: string, compaction: string): Promise<number> {
    return this.#records.summaryCount(tenantId, threadId, compaction);
  }

  savePauseAnswer(
    ...args: Parameters<ExecutionRecordRepository["savePauseAnswer"]>
  ): Promise<void> {
    return this.#records.savePauseAnswer(...args);
  }

  markPauseAnswerNotTaken(
    ...args: Parameters<ExecutionRecordRepository["markPauseAnswerNotTaken"]>
  ): Promise<void> {
    return this.#records.markPauseAnswerNotTaken(...args);
  }

  findPauseAnswersByTenantIdAndRootExecutionId(
    ...args: Parameters<ExecutionRecordRepository["findPauseAnswersByTenantIdAndRootExecutionId"]>
  ): Promise<PauseAnswerRecord[]> {
    return this.#records.findPauseAnswersByTenantIdAndRootExecutionId(...args);
  }
}

sqliteImplementation(SqliteExecutionRecordRepository);
