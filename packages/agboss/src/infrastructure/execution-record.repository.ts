import { assertAnswerInstants } from "./pause-answer-instants.js";
import { statusPageOf, type ExecutionRecordStatusQuery } from "./execution-record-status-page.js";
import { ExecutionRecordRepository } from "./execution-record-contract.js";
import type { Page } from "../app/page.js";

export { ExecutionRecordRepository } from "./execution-record-contract.js";
export type { ExecutionRecordStatusQuery } from "./execution-record-status-page.js";
import {
  createSqliteTurnStore,
  memoryStatusLog,
  pauseAnswerEntryOf,
  type ConfigSnapshot,
  type NewSummary,
  type NewTurn,
  type NewThread,
  type StatusContext,
  type StatusLog,
  type Summary,
  type ThreadStatusTransition,
  type Turn,
  type TurnOutcome,
  type TurnStore,
  type TurnTree,
  type VersionScore,
} from "../turns/index.js";
import { IN_MEMORY_DATABASE, InMemoryDatabase } from "./in-memory-database.js";
import { inMemoryInterruptedOf } from "./in-memory-cancel-mark.js";
import type { EndedTree } from "./execution-audit-log.repository.js";
import { Injectable } from "../components/decorators.js";
import type { PauseAnswerRecord } from "../flow/runtime/execution-record.js";
import { Clock, IdGenerator, lazyLoad, mintedThreadIdsOf } from "./clock.js";

export type { NewThread } from "../turns/index.js";

export { ExecutionRecordStatus } from "./execution-record-status.js";

/** What a pause answer is saved by: its tenant, its tree and the entry. */
export type AnswerArgs = Parameters<ExecutionRecordRepository["savePauseAnswer"]>;

/** A Turn store with no lease row beside it: no tree's mark is visible to its writes. */
const NO_MARKS = (): boolean => false;

/** The records kept in a Turn store: what the built-in default and the SQLite ones build on. */
export class TurnStoreRecordRepository extends ExecutionRecordRepository {
  /**
   * `isInterrupted` reads a tree's stop and cancel marks on the lease store's backend, inside the
   * Turn store's write (#1341b); a Turn store off that backend sees none (`NO_MARKS`).
   */
  constructor(
    private readonly store: TurnStore,
    private readonly isInterrupted: (tree: TurnTree) => boolean = NO_MARKS,
  ) {
    super();
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }

  createThread(thread: NewThread): Promise<string> {
    return this.store.createThread(thread);
  }
  hasThread(workflow: string, tenantId: string, threadId: string): Promise<boolean> {
    return this.store.hasThread(workflow, tenantId, threadId);
  }
  threadOwner(...args: Parameters<TurnStore["threadOwner"]>): ReturnType<TurnStore["threadOwner"]> {
    return this.store.threadOwner(...args);
  }
  append(turn: NewTurn, context?: StatusContext): Promise<Turn> {
    return this.store.append(turn, context);
  }
  complete(turnId: string, outcome: TurnOutcome, context?: StatusContext): Promise<void> {
    return this.store.complete(turnId, outcome, context);
  }
  statusHistory(tenantId: string, threadId: string): Promise<readonly ThreadStatusTransition[]> {
    return this.store.statusHistory({ tenantId, threadId });
  }
  forgetStatusHistory(tenantId: string, threadId: string): Promise<void> {
    return this.store.forgetStatusHistory(tenantId, threadId);
  }
  completeIfStatus(...args: Parameters<TurnStore["completeIfStatus"]>): Promise<boolean> {
    return this.store.completeIfStatus(...args);
  }
  completeUnlessInterrupted(
    turnId: string,
    outcome: TurnOutcome,
    context?: StatusContext,
  ): Promise<boolean> {
    return this.store.completeUnlessInterrupted(turnId, outcome, context, this.isInterrupted);
  }
  lastTurns(tenantId: string, threadId: string, limit: number): Promise<Turn[]> {
    return this.store.lastTurns(tenantId, threadId, limit);
  }
  byIds(ids: readonly string[]): Promise<Turn[]> {
    return this.store.byIds(ids);
  }
  async findByStatus(query: ExecutionRecordStatusQuery): Promise<Page<Turn>> {
    return statusPageOf(query, (limit, after) => this.store.byStatus(query.status, limit, after));
  }
  findByTenantIdAndRunId(tenantId: string, runId: string): Promise<Turn | undefined> {
    return this.store.findByTenantIdAndRunId(tenantId, runId);
  }
  byVersion(workflow: string, promptVersion: string, limit: number): Promise<Turn[]> {
    return this.store.byVersion(workflow, promptVersion, limit);
  }
  unscored(workflow: string, promptVersion: string | undefined, limit: number): Promise<Turn[]> {
    return this.store.unscored(workflow, promptVersion, limit);
  }
  deleteIdleThreads(cutoffs: ReadonlyMap<string, Date>, isEnded: EndedTree): Promise<number> {
    return this.store.deleteIdleThreads(cutoffs, isEnded);
  }
  saveScore(turnId: string, judge: string, score: number): Promise<void> {
    return this.store.saveScore(turnId, judge, score);
  }
  meanScore(turnIds: readonly string[]): Promise<number | null> {
    return this.store.meanScore(turnIds);
  }
  summary(workflow: string): Promise<VersionScore[]> {
    return this.store.summary(workflow);
  }
  rememberConfig(...args: Parameters<TurnStore["rememberConfig"]>): Promise<{ drift: boolean }> {
    return this.store.rememberConfig(...args);
  }
  configSnapshots(workflow: string, version: string): Promise<ConfigSnapshot[]> {
    return this.store.configSnapshots(workflow, version);
  }
  recentOriginals(workflow: string, limit: number): Promise<Turn[]> {
    return this.store.recentOriginals(workflow, limit);
  }
  uncovered(tenantId: string, threadId: string, memory: string): Promise<Turn[]> {
    return this.store.uncovered(tenantId, threadId, memory);
  }
  before(tenantId: string, threadId: string, turnId: string, limit: number): Promise<Turn[]> {
    return this.store.before(tenantId, threadId, turnId, limit);
  }
  turnNumber(tenantId: string, threadId: string, turnId: string): Promise<number> {
    return this.store.turnNumber(tenantId, threadId, turnId);
  }
  addSummary(summary: NewSummary): Promise<Summary> {
    return this.store.addSummary(summary);
  }
  latestSummaries(...args: Parameters<TurnStore["latestSummaries"]>): Promise<Summary[]> {
    return this.store.latestSummaries(...args);
  }
  summaryCount(tenantId: string, threadId: string, memory: string): Promise<number> {
    return this.store.summaryCount(tenantId, threadId, memory);
  }
  // async: an Invalid Date in the answer rejects, it never throws before the promise exists
  async savePauseAnswer(...args: AnswerArgs): Promise<void> {
    assertAnswerInstants(args[2]);
    await this.store.appendPauseAnswer(pauseAnswerEntryOf(...args));
  }
  async markPauseAnswerNotTaken(...args: AnswerArgs): Promise<void> {
    assertAnswerInstants(args[2]);
    await this.store.markNotTaken(pauseAnswerEntryOf(...args));
  }
  async findPauseAnswersByTenantIdAndRootExecutionId(
    ...args: Parameters<TurnStore["pauseAnswersOf"]>
  ): Promise<PauseAnswerRecord[]> {
    const records = await this.store.pauseAnswersOf(...args);
    const { pauseAnswerRecordOfJson } = await lazyLoad(import("./pause-answer-log.js"));
    return records.map(pauseAnswerRecordOfJson);
  }
}

/**
 * The built-in default: the records in an in-memory database of this application instance — lost
 * on restart, never written to disk; a new thread's id from the application's `IdGenerator`.
 */
@Injectable({ deps: [Clock, IdGenerator, IN_MEMORY_DATABASE] })
export class InMemoryExecutionRecordRepository extends TurnStoreRecordRepository {
  constructor(
    clock: Clock,
    idGenerator: IdGenerator,
    database: InMemoryDatabase = new InMemoryDatabase(),
  ) {
    const log: StatusLog = memoryStatusLog(database.statusTransitions);
    super(
      createSqliteTurnStore(":memory:", () => clock.now(), mintedThreadIdsOf(idGenerator), log),
      // the marks are the in-memory lease store's, read in the finish's synchronous step (#1341b)
      inMemoryInterruptedOf(database),
    );
  }
}
