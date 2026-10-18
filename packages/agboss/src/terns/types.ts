import type { MessageContent } from "@langchain/core/messages";
/** Terminology: a Tern is one question → replyWith round (one run). A thread is a client's sequence of Terns. */

/**
 * Where a Tern is: `running` while its execution moves (#265 S30: what recovery looks for), then
 * how it ended — `answered`, `guarded`, `failed` — or `paused`.
 */
export const TERN_STATUSES = ["running", "answered", "guarded", "failed", "paused"] as const;
export type TernStatus = (typeof TERN_STATUSES)[number];

/** One step inside a Tern: what one agent answered. */
export interface TernStep {
  readonly agent: string;
  readonly content: MessageContent;
}

export interface Tern {
  readonly id: string;
  /** The run that wrote it (`ExecutionOutput.runId`, `executionContext.executionId`); null for Terns before #238. */
  readonly runId: string | null;
  readonly threadId: string;
  /** The tenant of its thread (#261): `"default"` for a thread that names none. */
  readonly tenantId: string;
  readonly bundle: string;
  readonly createdAt: string;
  readonly task: string;
  readonly replyWith: string;
  readonly status: TernStatus;
  readonly stopReason: string;
  readonly route: readonly string[];
  readonly steps: readonly TernStep[];
  readonly costUsd: number;
  readonly promptVersion: string;
  readonly modelVersion: string;
  /** Id of the Tern this one replays, if any. */
  readonly replayOf: string | null;
  /** Declared config version and hash of the resolved config (null for runs before #78). */
  readonly configVersion: string | null;
  readonly configHash: string | null;
}

export type NewTern = Omit<Tern, "id" | "createdAt">;

/** A memory note of consecutive turns of a thread (compaction). Never re-compacted. */
export interface Summary {
  readonly id: string;
  readonly threadId: string;
  readonly bundle: string;
  readonly fromTernId: string;
  readonly toTernId: string;
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
  /** The latest `limit` original (not replayed) answered Terns of a workflow, oldest first. */
  readonly recentOriginals: (bundle: string, limit: number) => Promise<Tern[]>;
}

/** Conversation memory: which turns are not yet summarised, and the summaries. */
export interface MemoryStore {
  /** Turns of the thread after the last summary, oldest first. */
  readonly uncovered: (threadId: string) => Promise<Tern[]>;
  /** Up to `limit` turns right before `ternId`, oldest first. */
  readonly before: (threadId: string, ternId: string, limit: number) => Promise<Tern[]>;
  /** 1-based position of a turn in its thread. */
  readonly turnNumber: (threadId: string, ternId: string) => Promise<number>;
  readonly addSummary: (summary: NewSummary) => Promise<Summary>;
  /** The latest `limit` summaries of the thread, oldest first. */
  readonly latestSummaries: (threadId: string, limit: number) => Promise<Summary[]>;
  readonly summaryCount: (threadId: string) => Promise<number>;
}

/** What changes when a paused Tern finishes. */
export type TernOutcome = Pick<
  Tern,
  "replyWith" | "status" | "stopReason" | "route" | "steps" | "costUsd"
>;

/** Mean judge score and total cost of the Terns of one prompt version. */
export interface VersionScore {
  readonly promptVersion: string;
  readonly terns: number;
  readonly scored: number;
  readonly meanScore: number | null;
  readonly costUsd: number;
}

/** Durable memory of runs: threads, Terns, their quality scores and conversation summaries. */
export interface TernStore extends MemoryStore, ConfigStore {
  /**
   * A new thread of the workflow in a tenant (#261: tenant + thread is its key); with an `owner`,
   * only that owner may continue it (#202); with a `threadId`, under the caller's own id (#262 Q4) —
   * one that exists already is kept as it is. The reads by thread below take its key
   * (`threadKeyOf(tenantId, threadId)`, tenant + thread).
   */
  readonly createThread: (
    bundle: string,
    tenantId: string,
    owner?: string,
    threadId?: string,
  ) => Promise<string>;
  /** Whether the tenant has the thread: another tenant's thread does not exist for it. */
  readonly hasThread: (bundle: string, tenantId: string, threadId: string) => Promise<boolean>;
  /** The thread's owner (`owner: undefined` = created without one); `undefined` = no such thread. */
  readonly threadOwner: (
    bundle: string,
    tenantId: string,
    threadId: string,
  ) => Promise<{ readonly owner: string | undefined } | undefined>;
  readonly append: (tern: NewTern) => Promise<Tern>;
  /** Completes a paused Tern (same id) with its final outcome. */
  readonly complete: (ternId: string, outcome: TernOutcome) => Promise<void>;
  /**
   * Compare-and-set (#265 S66 h): writes the outcome only while the Tern's status is `expected`;
   * `true` when it did. Atomic, so a late write never replaces what another holder wrote since.
   */
  completeIfStatus(ternId: string, expected: TernStatus, outcome: TernOutcome): Promise<boolean>;
  /** The last `limit` Terns of a thread, oldest first. */
  readonly lastTerns: (threadId: string, limit: number) => Promise<Tern[]>;
  readonly byIds: (ids: readonly string[]) => Promise<Tern[]>;
  /** Up to `limit` Terns with `status`, oldest first, after the Tern `after` (a page of them). */
  readonly byStatus: (status: TernStatus, limit: number, after?: string) => Promise<Tern[]>;
  /** Original (non-replay) Terns of a prompt version, oldest first; a run in flight (`running`) is no result. */
  readonly byVersion: (bundle: string, promptVersion: string, limit: number) => Promise<Tern[]>;
  /** Answered Terns without a score, oldest first. */
  readonly unscored: (
    bundle: string,
    promptVersion: string | undefined,
    limit: number,
  ) => Promise<Tern[]>;
  readonly saveScore: (ternId: string, judge: string, score: number) => Promise<void>;
  readonly meanScore: (ternIds: readonly string[]) => Promise<number | null>;
  readonly summary: (bundle: string) => Promise<VersionScore[]>;
  readonly close: () => void;
}

/** What a run reads and writes of its records (the store without its own `close`, nor recovery's look-up). */
export type TernRecords = Omit<TernStore, "close" | "byStatus">;
