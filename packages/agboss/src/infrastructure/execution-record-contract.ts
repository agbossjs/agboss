import type { Page } from "../app/page.js";
import type { ExecutionRecordStatusQuery } from "./execution-record-status-page.js";
import type {
  ConfigSnapshot,
  NewSummary,
  NewTurn,
  NewThread,
  StatusContext,
  Summary,
  ThreadStatusTransition,
  Turn,
  TurnOutcome,
  VersionScore,
} from "../turns/index.js";
import type { EndedTree } from "./execution-audit-log.repository.js";
import type { PauseAnswerRecord } from "../flow/runtime/execution-record.js";
import type { ExecutionRecordStatus } from "./execution-record-status.js";

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
  ): Promise<{ readonly owner: string | undefined; readonly isSwept?: true } | undefined>;
  /**
   * Appends a record. The thread's status change it makes (#1341d) is written to
   * `thread_status_transitions` in the very transaction of the write; `context` names the command
   * behind it (`trigger`, `reason`, `actor`, `leaseToken`) when there is one.
   */
  abstract append(turn: NewTurn, context?: StatusContext): Promise<Turn>;
  /**
   * Completes a paused record (same id) with its final outcome; its status change is written to
   * the thread's history in the same transaction (#1341d).
   */
  abstract complete(turnId: string, outcome: TurnOutcome, context?: StatusContext): Promise<void>;
  /**
   * Compare-and-set (#265 S66 h): writes the outcome only while the record's status is `expected`,
   * atomically; `true` when it did. A resume marks its paused record `running` this way, so its
   * write never lands over the outcome a holder wrote meanwhile.
   */
  abstract completeIfStatus(
    turnId: string,
    expected: ExecutionRecordStatus,
    outcome: TurnOutcome,
    context?: StatusContext,
  ): Promise<boolean>;
  /**
   * The thread's status history (#1341d), oldest first: one row per change of its status, written
   * in the transaction of the change (a record's status write, a lease's stop or cancel mark);
   * empty for a thread with none. Removed with the thread (`deleteIdleThreads`, and its tree's
   * `forgetTree` when no history is kept).
   */
  abstract statusHistory(
    tenantId: string,
    threadId: string,
  ): Promise<readonly ThreadStatusTransition[]>;
  /**
   * Removes the thread's status history (#1341d): what `forgetTree` does when the application keeps
   * no execution history (`@Workflow.historyTtl` is `Ttl.None`), so no row of it outlives its
   * thread's transient rows. Idempotent; a thread with none is a no-op.
   */
  abstract forgetStatusHistory(tenantId: string, threadId: string): Promise<void>;
  /** The last `limit` records of a thread, oldest first. */
  abstract lastTurns(tenantId: string, threadId: string, limit: number): Promise<Turn[]>;
  abstract byIds(ids: readonly string[]): Promise<Turn[]>;
  /**
   * A page of the records with `query.status`, oldest first: up to `query.limit`, after the page
   * whose `nextCursor` is `query.cursor`. Recovery reads `ExecutionRecordStatus.Running` (#265 S30).
   */
  abstract findByStatus(query: ExecutionRecordStatusQuery): Promise<Page<Turn>>;
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
  /**
   * The sweep of `@Memory({ ttl })` (#1303): removes each workflow's threads last active before its
   * `cutoffs` entry, with their records, summaries, owners and pause answers — never a thread with a
   * `running`, `paused` or `queued` record, or of a run `isEnded` does not answer `true` for (asked
   * once per run), decided again inside the removal. How many threads went (a bounded batch).
   */
  abstract deleteIdleThreads(
    cutoffs: ReadonlyMap<string, Date>,
    isEnded: EndedTree,
  ): Promise<number>;
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
  abstract uncovered(tenantId: string, threadId: string, memory: string): Promise<Turn[]>;
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
    memory: string,
    limit: number,
  ): Promise<Summary[]>;
  abstract summaryCount(tenantId: string, threadId: string, memory: string): Promise<number>;
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
  /**
   * Writes that a pause's answer was not taken (I12): `answer` (`isTaken: false`) over any entry of
   * the same tenant, `rootExecutionId` and `step.idempotencyKey`, keeping that entry's place in the
   * order — and a `savePauseAnswer` that comes after is ignored, so in either order the final entry
   * says *not taken* and keeps the answer and who gave it.
   */
  abstract markPauseAnswerNotTaken(
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
