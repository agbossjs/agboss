import { Injectable } from "../components/decorators.js";
import {
  createSqliteTurnStore,
  pauseAnswerEntryOf,
  type ConfigSnapshot,
  type NewSummary,
  type NewTurn,
  type NewThread,
  type Summary,
  type Turn,
  type TurnOutcome,
  type TurnStore,
  type VersionScore,
} from "../turns/index.js";
import type { PauseAnswerRecord } from "../flow/runtime/execution-record.js";
import { Clock, IdGenerator, mintedThreadIdsOf } from "./clock.js";
import { pauseAnswerRecordOfJson } from "./pause-record.js";

export type { NewThread } from "../turns/index.js";

/**
 * Where an execution's record is (#265 S30): `Running` while its tree moves — what recovery looks
 * for — then how it ended, or `Paused`.
 */
export enum ExecutionRecordStatus {
  /** The tree moves (or its instance died while it moved: recovery continues it). */
  Running = "running",
  /** It reached a workflow finish. */
  Answered = "answered",
  /** A guard stopped it. */
  Guarded = "guarded",
  /** It failed (its error in the record's `stopReason`). */
  Failed = "failed",
  /** It waits for a decision. */
  Paused = "paused",
  /**
   * A child execution waiting in the application's queue for an instance to claim it (#333 PR 2,
   * `ChildPlacement.AnyInstance`): a `ChildExecutionQueueRepository` row only.
   */
  Queued = "queued",
  /**
   * A past turn an eval case wrote into its thread (#396 S6: `evalCase({ history })`), never run: a
   * turn its thread's memory reads, left out of `agboss eval score` and `agboss golden add`.
   */
  Written = "written",
}

/**
 * Infrastructure (#261, S28): the records of the application's executions — threads and their
 * owners — keyed by tenant + thread (#261) — one record per execution (a Turn until #268 renames
 * it, carrying its `tenantId`), quality scores, conversation
 * summaries and config snapshots. One per application, listed only in `@Application({ providers })`;
 * the built-in default is in memory. Your own `extends ExecutionRecordRepository`.
 */
export abstract class ExecutionRecordRepository {
  /**
   * Whether the store answers (#300): resolves when it is reachable, rejects with why not. One fast
   * round trip (`SELECT 1`, a `PING`), never a scan — `app.checkReadiness()` calls it under a
   * timeout of its own.
   */
  abstract ping(): Promise<void>;
  /**
   * A new thread (#261 S72: its key is `tenantId` + `threadId` — the same id in two tenants is two
   * threads); with an `ownerId`, only that owner may continue it; with a `threadId`, the caller's
   * own id (#262 Q4) — one the tenant has already is kept as it is — else one is made, never an
   * id the tenant has a thread of (#550: an `IdGenerator` may repeat one — mint the next). Its id.
   * Every read by thread below names the thread by both, `(tenantId, threadId, …)`.
   */
  abstract createThread(thread: NewThread): Promise<string>;
  /** Whether the tenant has the thread: another tenant's thread does not exist for it. */
  abstract hasThread(workflow: string, tenantId: string, threadId: string): Promise<boolean>;
  /** The thread's owner (`owner: undefined` = created without one); `undefined` = no such thread. */
  abstract threadOwner(
    workflow: string,
    tenantId: string,
    threadId: string,
  ): Promise<{ readonly owner: string | undefined } | undefined>;
  abstract append(turn: NewTurn): Promise<Turn>;
  /** Completes a paused record (same id) with its final outcome. */
  abstract complete(turnId: string, outcome: TurnOutcome): Promise<void>;
  /**
   * Compare-and-set (#265 S66 h): writes the outcome only while the record's status is `expected`,
   * atomically; `true` when it did. A resume marks its paused record `running` this way, so its
   * write never lands over the outcome a holder wrote meanwhile.
   */
  abstract completeIfStatus(
    turnId: string,
    expected: ExecutionRecordStatus,
    outcome: TurnOutcome,
  ): Promise<boolean>;
  /** The last `limit` records of a thread, oldest first. */
  abstract lastTurns(tenantId: string, threadId: string, limit: number): Promise<Turn[]>;
  abstract byIds(ids: readonly string[]): Promise<Turn[]>;
  /**
   * A page of the records with `status`, oldest first: up to `limit`, after the record `after`
   * (the last id of the previous page). Recovery reads `ExecutionRecordStatus.Running` (#265 S30).
   */
  abstract findByStatus(
    status: ExecutionRecordStatus,
    limit: number,
    after?: string,
  ): Promise<Turn[]>;
  /**
   * The record an execution of the tenant wrote (#808), by its id (`runId`, a root's: its A2A task
   * id) — the latest one if it wrote several —, however many later records its thread has;
   * `undefined` when it wrote none. Read repair finds a task's root record this way.
   */
  abstract findByTenantIdAndRunId(tenantId: string, runId: string): Promise<Turn | undefined>;
  /** Original (non-replay) records of a prompt version, oldest first; `running` ones left out. */
  abstract byVersion(workflow: string, promptVersion: string, limit: number): Promise<Turn[]>;
  /** Answered records without a score, oldest first. */
  abstract unscored(
    workflow: string,
    promptVersion: string | undefined,
    limit: number,
  ): Promise<Turn[]>;
  abstract saveScore(turnId: string, judge: string, score: number): Promise<void>;
  abstract meanScore(turnIds: readonly string[]): Promise<number | null>;
  /** Mean score and cost per prompt version; `running` records left out (a run in flight is no result). */
  abstract summary(workflow: string): Promise<VersionScore[]>;
  /** Stores the snapshot the first time; `drift` when the version already has another hash. */
  abstract rememberConfig(
    workflow: string,
    version: string,
    hash: string,
    snapshot: string,
  ): Promise<{ readonly drift: boolean }>;
  abstract configSnapshots(workflow: string, version: string): Promise<ConfigSnapshot[]>;
  /** The latest `limit` original answered records of a workflow, oldest first. */
  abstract recentOriginals(workflow: string, limit: number): Promise<Turn[]>;
  /** Records of the thread after the compaction's last summary, oldest first (#120 PR 3). */
  abstract uncovered(tenantId: string, threadId: string, compaction: string): Promise<Turn[]>;
  /** Up to `limit` records right before `turnId`, oldest first. */
  abstract before(
    tenantId: string,
    threadId: string,
    turnId: string,
    limit: number,
  ): Promise<Turn[]>;
  /** 1-based position of a record in its thread. */
  abstract turnNumber(tenantId: string, threadId: string, turnId: string): Promise<number>;
  /** A summary of a thread: it carries the thread's `tenantId` and `threadId`. */
  abstract addSummary(summary: NewSummary): Promise<Summary>;
  /** The compaction's latest `limit` summaries of the thread, oldest first. */
  abstract latestSummaries(
    tenantId: string,
    threadId: string,
    compaction: string,
    limit: number,
  ): Promise<Summary[]>;
  abstract summaryCount(tenantId: string, threadId: string, compaction: string): Promise<number>;
  /**
   * Keeps how a pause of a tree was resolved (#267 S107), once per pause of the tree (by its
   * tenant, `rootExecutionId` and `step.idempotencyKey`: a second save is ignored; #676 — a step
   * key names no tree, so another tree's pause under the same key keeps its own answer) — the
   * permanent log `ExecutionRecord.pauses` reads, whatever the pause records' retention removed
   * since.
   */
  abstract savePauseAnswer(
    tenantId: string,
    rootExecutionId: string,
    answer: PauseAnswerRecord,
  ): Promise<void>;
  /** The resolved pauses of a tree, in the order they were asked (ties in the order saved). */
  abstract findPauseAnswersByTenantIdAndRootExecutionId(
    tenantId: string,
    rootExecutionId: string,
  ): Promise<PauseAnswerRecord[]>;
}

/** The records kept in a Turn store: what the built-in default and the SQLite ones build on. */
export class TurnStoreRecordRepository extends ExecutionRecordRepository {
  readonly #store: TurnStore;

  constructor(store: TurnStore) {
    super();
    this.#store = store;
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }

  createThread(thread: NewThread): Promise<string> {
    return this.#store.createThread(thread);
  }
  hasThread(workflow: string, tenantId: string, threadId: string): Promise<boolean> {
    return this.#store.hasThread(workflow, tenantId, threadId);
  }
  threadOwner(...args: Parameters<TurnStore["threadOwner"]>): ReturnType<TurnStore["threadOwner"]> {
    return this.#store.threadOwner(...args);
  }
  append(turn: NewTurn): Promise<Turn> {
    return this.#store.append(turn);
  }
  complete(turnId: string, outcome: TurnOutcome): Promise<void> {
    return this.#store.complete(turnId, outcome);
  }
  completeIfStatus(
    turnId: string,
    expected: ExecutionRecordStatus,
    outcome: TurnOutcome,
  ): Promise<boolean> {
    return this.#store.completeIfStatus(turnId, expected, outcome);
  }
  lastTurns(tenantId: string, threadId: string, limit: number): Promise<Turn[]> {
    return this.#store.lastTurns(tenantId, threadId, limit);
  }
  byIds(ids: readonly string[]): Promise<Turn[]> {
    return this.#store.byIds(ids);
  }
  findByStatus(status: ExecutionRecordStatus, limit: number, after?: string): Promise<Turn[]> {
    return this.#store.byStatus(status, limit, after);
  }
  findByTenantIdAndRunId(tenantId: string, runId: string): Promise<Turn | undefined> {
    return this.#store.findByTenantIdAndRunId(tenantId, runId);
  }
  byVersion(workflow: string, promptVersion: string, limit: number): Promise<Turn[]> {
    return this.#store.byVersion(workflow, promptVersion, limit);
  }
  unscored(workflow: string, promptVersion: string | undefined, limit: number): Promise<Turn[]> {
    return this.#store.unscored(workflow, promptVersion, limit);
  }
  saveScore(turnId: string, judge: string, score: number): Promise<void> {
    return this.#store.saveScore(turnId, judge, score);
  }
  meanScore(turnIds: readonly string[]): Promise<number | null> {
    return this.#store.meanScore(turnIds);
  }
  summary(workflow: string): Promise<VersionScore[]> {
    return this.#store.summary(workflow);
  }
  rememberConfig(...args: Parameters<TurnStore["rememberConfig"]>): Promise<{ drift: boolean }> {
    return this.#store.rememberConfig(...args);
  }
  configSnapshots(workflow: string, version: string): Promise<ConfigSnapshot[]> {
    return this.#store.configSnapshots(workflow, version);
  }
  recentOriginals(workflow: string, limit: number): Promise<Turn[]> {
    return this.#store.recentOriginals(workflow, limit);
  }
  uncovered(tenantId: string, threadId: string, compaction: string): Promise<Turn[]> {
    return this.#store.uncovered(tenantId, threadId, compaction);
  }
  before(tenantId: string, threadId: string, turnId: string, limit: number): Promise<Turn[]> {
    return this.#store.before(tenantId, threadId, turnId, limit);
  }
  turnNumber(tenantId: string, threadId: string, turnId: string): Promise<number> {
    return this.#store.turnNumber(tenantId, threadId, turnId);
  }
  addSummary(summary: NewSummary): Promise<Summary> {
    return this.#store.addSummary(summary);
  }
  latestSummaries(...args: Parameters<TurnStore["latestSummaries"]>): Promise<Summary[]> {
    return this.#store.latestSummaries(...args);
  }
  summaryCount(tenantId: string, threadId: string, compaction: string): Promise<number> {
    return this.#store.summaryCount(tenantId, threadId, compaction);
  }
  savePauseAnswer(
    tenantId: string,
    rootExecutionId: string,
    answer: PauseAnswerRecord,
  ): Promise<void> {
    return this.#store.appendPauseAnswer(pauseAnswerEntryOf(tenantId, rootExecutionId, answer));
  }
  async findPauseAnswersByTenantIdAndRootExecutionId(
    tenantId: string,
    rootExecutionId: string,
  ): Promise<PauseAnswerRecord[]> {
    const records = await this.#store.pauseAnswersOf(tenantId, rootExecutionId);
    return records.map(pauseAnswerRecordOfJson);
  }
}

/**
 * The built-in default: the records in an in-memory database of this application instance — lost
 * on restart, never written to disk; a new thread's id from the application's `IdGenerator`.
 */
@Injectable({ deps: [Clock, IdGenerator] })
export class InMemoryExecutionRecordRepository extends TurnStoreRecordRepository {
  constructor(clock: Clock, idGenerator: IdGenerator) {
    super(createSqliteTurnStore(":memory:", () => clock.now(), mintedThreadIdsOf(idGenerator)));
  }
}
