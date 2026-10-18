import { Injectable } from "../components/decorators.js";
import {
  createSqliteTernStore,
  type ConfigSnapshot,
  type NewSummary,
  type NewTern,
  type Summary,
  type Tern,
  type TernOutcome,
  type TernStore,
  type VersionScore,
} from "../terns/index.js";
import { INFRASTRUCTURE_CLOCK, NEW_THREAD_ID } from "./clock.js";

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
}

/**
 * Infrastructure (#261, S28): the records of the application's executions — threads and their
 * owners, one record per execution (a Tern until #268 renames it), quality scores, conversation
 * summaries and config snapshots. One per application, listed only in `@Application({ providers })`;
 * the built-in default is in memory. Your own `extends ExecutionRecordRepository`.
 */
export abstract class ExecutionRecordRepository {
  /** A new thread of the workflow; with an `owner`, only that owner may continue it. */
  abstract createThread(workflow: string, owner?: string): Promise<string>;
  abstract hasThread(workflow: string, threadId: string): Promise<boolean>;
  /** The thread's owner (`owner: undefined` = created without one); `undefined` = no such thread. */
  abstract threadOwner(
    workflow: string,
    threadId: string,
  ): Promise<{ readonly owner: string | undefined } | undefined>;
  abstract append(tern: NewTern): Promise<Tern>;
  /** Completes a paused record (same id) with its final outcome. */
  abstract complete(ternId: string, outcome: TernOutcome): Promise<void>;
  /**
   * Compare-and-set (#265 S66 h): writes the outcome only while the record's status is `expected`,
   * atomically; `true` when it did. A resume marks its paused record `running` this way, so its
   * write never lands over the outcome a holder wrote meanwhile.
   */
  abstract completeIfStatus(
    ternId: string,
    expected: ExecutionRecordStatus,
    outcome: TernOutcome,
  ): Promise<boolean>;
  /** The last `limit` records of a thread, oldest first. */
  abstract lastTerns(threadId: string, limit: number): Promise<Tern[]>;
  abstract byIds(ids: readonly string[]): Promise<Tern[]>;
  /**
   * A page of the records with `status`, oldest first: up to `limit`, after the record `after`
   * (the last id of the previous page). Recovery reads `ExecutionRecordStatus.Running` (#265 S30).
   */
  abstract findByStatus(
    status: ExecutionRecordStatus,
    limit: number,
    after?: string,
  ): Promise<Tern[]>;
  /** Original (non-replay) records of a prompt version, oldest first; `running` ones left out. */
  abstract byVersion(workflow: string, promptVersion: string, limit: number): Promise<Tern[]>;
  /** Answered records without a score, oldest first. */
  abstract unscored(
    workflow: string,
    promptVersion: string | undefined,
    limit: number,
  ): Promise<Tern[]>;
  abstract saveScore(ternId: string, judge: string, score: number): Promise<void>;
  abstract meanScore(ternIds: readonly string[]): Promise<number | null>;
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
  abstract recentOriginals(workflow: string, limit: number): Promise<Tern[]>;
  /** Records of the thread after its last summary, oldest first. */
  abstract uncovered(threadId: string): Promise<Tern[]>;
  /** Up to `limit` records right before `ternId`, oldest first. */
  abstract before(threadId: string, ternId: string, limit: number): Promise<Tern[]>;
  /** 1-based position of a record in its thread. */
  abstract turnNumber(threadId: string, ternId: string): Promise<number>;
  abstract addSummary(summary: NewSummary): Promise<Summary>;
  /** The latest `limit` summaries of the thread, oldest first. */
  abstract latestSummaries(threadId: string, limit: number): Promise<Summary[]>;
  abstract summaryCount(threadId: string): Promise<number>;
}

/** The records in a Tern store (internal): what the built-in default and the SQLite ones build on. */
export class TernStoreRecordRepository extends ExecutionRecordRepository {
  readonly #store: TernStore;

  constructor(store: TernStore) {
    super();
    this.#store = store;
  }

  createThread(workflow: string, owner?: string): Promise<string> {
    return this.#store.createThread(workflow, owner);
  }
  hasThread(workflow: string, threadId: string): Promise<boolean> {
    return this.#store.hasThread(workflow, threadId);
  }
  threadOwner(
    workflow: string,
    threadId: string,
  ): Promise<{ readonly owner: string | undefined } | undefined> {
    return this.#store.threadOwner(workflow, threadId);
  }
  append(tern: NewTern): Promise<Tern> {
    return this.#store.append(tern);
  }
  complete(ternId: string, outcome: TernOutcome): Promise<void> {
    return this.#store.complete(ternId, outcome);
  }
  completeIfStatus(
    ternId: string,
    expected: ExecutionRecordStatus,
    outcome: TernOutcome,
  ): Promise<boolean> {
    return this.#store.completeIfStatus(ternId, expected, outcome);
  }
  lastTerns(threadId: string, limit: number): Promise<Tern[]> {
    return this.#store.lastTerns(threadId, limit);
  }
  byIds(ids: readonly string[]): Promise<Tern[]> {
    return this.#store.byIds(ids);
  }
  findByStatus(status: ExecutionRecordStatus, limit: number, after?: string): Promise<Tern[]> {
    return this.#store.byStatus(status, limit, after);
  }
  byVersion(workflow: string, promptVersion: string, limit: number): Promise<Tern[]> {
    return this.#store.byVersion(workflow, promptVersion, limit);
  }
  unscored(workflow: string, promptVersion: string | undefined, limit: number): Promise<Tern[]> {
    return this.#store.unscored(workflow, promptVersion, limit);
  }
  saveScore(ternId: string, judge: string, score: number): Promise<void> {
    return this.#store.saveScore(ternId, judge, score);
  }
  meanScore(ternIds: readonly string[]): Promise<number | null> {
    return this.#store.meanScore(ternIds);
  }
  summary(workflow: string): Promise<VersionScore[]> {
    return this.#store.summary(workflow);
  }
  rememberConfig(
    workflow: string,
    version: string,
    hash: string,
    snapshot: string,
  ): Promise<{ readonly drift: boolean }> {
    return this.#store.rememberConfig(workflow, version, hash, snapshot);
  }
  configSnapshots(workflow: string, version: string): Promise<ConfigSnapshot[]> {
    return this.#store.configSnapshots(workflow, version);
  }
  recentOriginals(workflow: string, limit: number): Promise<Tern[]> {
    return this.#store.recentOriginals(workflow, limit);
  }
  uncovered(threadId: string): Promise<Tern[]> {
    return this.#store.uncovered(threadId);
  }
  before(threadId: string, ternId: string, limit: number): Promise<Tern[]> {
    return this.#store.before(threadId, ternId, limit);
  }
  turnNumber(threadId: string, ternId: string): Promise<number> {
    return this.#store.turnNumber(threadId, ternId);
  }
  addSummary(summary: NewSummary): Promise<Summary> {
    return this.#store.addSummary(summary);
  }
  latestSummaries(threadId: string, limit: number): Promise<Summary[]> {
    return this.#store.latestSummaries(threadId, limit);
  }
  summaryCount(threadId: string): Promise<number> {
    return this.#store.summaryCount(threadId);
  }
}

/**
 * The built-in default: the records in an in-memory database of this application instance — lost
 * on restart, never written to disk.
 */
@Injectable({ deps: [INFRASTRUCTURE_CLOCK, NEW_THREAD_ID] })
export class InMemoryExecutionRecordRepository extends TernStoreRecordRepository {
  constructor(now: () => Date, newThreadId: (() => string) | undefined) {
    super(createSqliteTernStore(":memory:", now, newThreadId));
  }
}
