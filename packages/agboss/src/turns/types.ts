import type { MessageContent } from "@langchain/core/messages";
/** Terminology: a Turn is one question → replyWith round (one run). A thread is a client's sequence of Turns. */

/**
 * Where a Turn is: `running` while its execution moves (#265 S30: what recovery looks for), then
 * how it ended — `answered`, `guarded`, `failed` — or `paused`; `written` — a past turn an eval case
 * wrote into its thread, never run (#396 S6): a turn of the thread, never a run to score or replay;
 * `queued` — a child waiting for an instance to claim it (#333 PR 2: its queue row; no Turn is).
 */
export type TurnStatus =
  "running" | "answered" | "guarded" | "failed" | "paused" | "queued" | "written";
/** Every {@link TurnStatus}, in that order (the SQLite store's check of a status it reads). */
export const TURN_STATUSES = [
  "running",
  "answered",
  "guarded",
  "failed",
  "paused",
  "queued",
  "written",
] as const satisfies readonly TurnStatus[];

/** One step inside a Turn: what one agent answered. */
export interface TurnStep {
  readonly agent: string;
  readonly content: MessageContent;
}

export interface Turn {
  readonly id: string;
  /** The run that wrote it (`ExecutionOutput.runId`, `executionContext.executionId`); null for Turns before #238. */
  readonly runId: string | null;
  readonly threadId: string;
  /** The tenant of its thread (#261): `"default"` for a thread that names none. */
  readonly tenantId: string;
  readonly bundle: string;
  readonly createdAt: string;
  readonly task: string;
  readonly replyWith: string;
  readonly status: TurnStatus;
  readonly stopReason: string;
  readonly route: readonly string[];
  readonly steps: readonly TurnStep[];
  readonly costUsd: number;
  readonly promptVersion: string;
  readonly modelVersion: string;
  /** Id of the Turn this one replays, if any. */
  readonly replayOf: string | null;
  /** Declared config version and hash of the resolved config (null for runs before #78). */
  readonly configVersion: string | null;
  readonly configHash: string | null;
}

export type NewTurn = Omit<Turn, "id" | "createdAt">;

/** A memory note of consecutive turns of a thread (compaction). Never re-compacted. */
export interface Summary {
  readonly id: string;
  /** The thread it summarises: its tenant and its id (#261 S72: the thread's key). */
  readonly tenantId: string;
  readonly threadId: string;
  readonly bundle: string;
  /** The `@Compaction` that wrote it (#120 PR 3): each keeps its own summaries of the thread. */
  readonly compaction: string;
  readonly fromTurnId: string;
  readonly toTurnId: string;
  readonly turns: number;
  readonly text: string;
  readonly costUsd: number;
  readonly createdAt: string;
}

export type NewSummary = Omit<Summary, "id" | "createdAt">;

/** A resolved config as first seen under a version. */
export interface ConfigSnapshot {
  readonly version: string;
  readonly hash: string;
  readonly snapshot: string;
  readonly firstSeen: string;
}

/** Readable config versions: snapshots and "changed without a version bump" detection. */
export interface ConfigStore {
  /** Stores the snapshot the first time; `drift` when the version already has another hash. */
  readonly rememberConfig: (
    bundle: string,
    version: string,
    hash: string,
    snapshot: string,
  ) => Promise<{ readonly drift: boolean }>;
  readonly configSnapshots: (bundle: string, version: string) => Promise<ConfigSnapshot[]>;
  /** The latest `limit` original (not replayed) answered Turns of a workflow, oldest first. */
  readonly recentOriginals: (bundle: string, limit: number) => Promise<Turn[]>;
}

/**
 * Conversation memory: which turns are not yet summarised, and the summaries. A thread is named by
 * its key, its tenant and its id (#261 S72): the same id in two tenants is two threads.
 */
export interface MemoryStore {
  /** Turns of the thread after the compaction's last summary, oldest first. */
  readonly uncovered: (tenantId: string, threadId: string, compaction: string) => Promise<Turn[]>;
  /** Up to `limit` turns right before `turnId`, oldest first. */
  readonly before: (
    tenantId: string,
    threadId: string,
    turnId: string,
    limit: number,
  ) => Promise<Turn[]>;
  /** 1-based position of a turn in its thread. */
  readonly turnNumber: (tenantId: string, threadId: string, turnId: string) => Promise<number>;
  readonly addSummary: (summary: NewSummary) => Promise<Summary>;
  /** The compaction's latest `limit` summaries of the thread, oldest first. */
  readonly latestSummaries: (
    tenantId: string,
    threadId: string,
    compaction: string,
    limit: number,
  ) => Promise<Summary[]>;
  readonly summaryCount: (
    tenantId: string,
    threadId: string,
    compaction: string,
  ) => Promise<number>;
}

/**
 * A thread to create (#261, #262 Q4): of a workflow in a tenant — its key is the tenant and the
 * id; with an `ownerId` only that owner may continue it; with a `threadId` it is the caller's own
 * id (one the tenant has already is kept as it is), else one is made.
 */
export interface NewThread {
  /** The workflow the thread belongs to. */
  readonly workflow: string;
  /** The tenant: with `threadId`, the thread's key. */
  readonly tenantId: string;
  /** The only owner who may continue it; none → anyone of the tenant. */
  readonly ownerId?: string | undefined;
  /** The caller's own id; none → a new one is made. */
  readonly threadId?: string | undefined;
}

/** What changes when a paused Turn finishes. */
export type TurnOutcome = Pick<
  Turn,
  "replyWith" | "status" | "stopReason" | "route" | "steps" | "costUsd"
>;

/** Mean judge score and total cost of the Turns of one prompt version. */
export interface VersionScore {
  readonly promptVersion: string;
  readonly turns: number;
  readonly scored: number;
  readonly meanScore: number | null;
  readonly costUsd: number;
}

/**
 * One resolved pause of an execution tree as the records keep it (#267 S107): the permanent log
 * behind `ExecutionRecord.pauses`. Turns know nothing of its shape: `record` is its JSON.
 */
export interface PauseAnswerEntry {
  readonly tenantId: string;
  readonly rootExecutionId: string;
  /** The waiting step's idempotency key: one entry per pause. */
  readonly stepKey: string;
  /** When the pause was asked (ISO 8601): the log's order. */
  readonly askedAt: string;
  readonly record: string;
}

/** Durable memory of runs: threads, Turns, their quality scores and conversation summaries. */
export interface TurnStore extends MemoryStore, ConfigStore {
  /** A new thread (`NewThread`); its id. */
  readonly createThread: (thread: NewThread) => Promise<string>;
  /** Whether the tenant has the thread: another tenant's thread does not exist for it. */
  readonly hasThread: (bundle: string, tenantId: string, threadId: string) => Promise<boolean>;
  /** The thread's owner (`owner: undefined` = created without one); `undefined` = no such thread. */
  readonly threadOwner: (
    bundle: string,
    tenantId: string,
    threadId: string,
  ) => Promise<{ readonly owner: string | undefined } | undefined>;
  readonly append: (turn: NewTurn) => Promise<Turn>;
  /** Completes a paused Turn (same id) with its final outcome. */
  readonly complete: (turnId: string, outcome: TurnOutcome) => Promise<void>;
  /**
   * Compare-and-set (#265 S66 h): writes the outcome only while the Turn's status is `expected`;
   * `true` when it did. Atomic, so a late write never replaces what another holder wrote since.
   */
  completeIfStatus(turnId: string, expected: TurnStatus, outcome: TurnOutcome): Promise<boolean>;
  /** The last `limit` Turns of a thread (its tenant and id), oldest first. */
  readonly lastTurns: (tenantId: string, threadId: string, limit: number) => Promise<Turn[]>;
  readonly byIds: (ids: readonly string[]) => Promise<Turn[]>;
  /** Up to `limit` Turns with `status`, oldest first, after the Turn `after` (a page of them). */
  readonly byStatus: (status: TurnStatus, limit: number, after?: string) => Promise<Turn[]>;
  /** The latest Turn a run of the tenant wrote (#808); `undefined` when it wrote none. */
  readonly findByTenantIdAndRunId: (tenantId: string, runId: string) => Promise<Turn | undefined>;
  /** Original (non-replay) Turns of a prompt version, oldest first; a run in flight (`running`) is no result. */
  readonly byVersion: (bundle: string, promptVersion: string, limit: number) => Promise<Turn[]>;
  /** Answered Turns without a score, oldest first. */
  readonly unscored: (
    bundle: string,
    promptVersion: string | undefined,
    limit: number,
  ) => Promise<Turn[]>;
  readonly saveScore: (turnId: string, judge: string, score: number) => Promise<void>;
  readonly meanScore: (turnIds: readonly string[]) => Promise<number | null>;
  readonly summary: (bundle: string) => Promise<VersionScore[]>;
  /** Keeps a resolved pause's entry once: a second one for its tenant and step key is ignored. */
  readonly appendPauseAnswer: (entry: PauseAnswerEntry) => Promise<void>;
  /**
   * Writes a pause's entry as *not taken* (I12): over an entry of its tenant, tree and step key,
   * which keeps its place in the order (`askedAt`, then kept order); a first entry when none is.
   */
  readonly markNotTaken: (entry: PauseAnswerEntry) => Promise<void>;
  /** The `record`s of a tree's entries, in the order asked (ties in the order kept). */
  readonly pauseAnswersOf: (tenantId: string, rootExecutionId: string) => Promise<string[]>;
  readonly close: () => void;
}

/**
 * What a run reads and writes of its records: the store without its own `close`, recovery's look-up
 * and the pause answer log (`ExecutionRecordRepository` types it).
 */
export type TurnRecords = Omit<
  TurnStore,
  "close" | "byStatus" | "appendPauseAnswer" | "markNotTaken" | "pauseAnswersOf"
>;
