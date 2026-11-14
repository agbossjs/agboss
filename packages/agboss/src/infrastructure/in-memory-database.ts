import { ExecutionCancelFencedError } from "../app/lease-lost.js";
import { InjectionToken } from "../components/injection.js";
import type { EffectKey } from "./effect-key.js";
import { cancelTreeOf } from "./issued-keys.js";
import { FencedEffectSettings, OutboundCallSettings } from "./fenced-effect-settings.js";
import type { StoredKeyFacts } from "./fenced-effect-key.js";
import type { ExecutionLease } from "./execution-lease.repository.js";
import type { ExecutionTreeValue } from "./execution-tree.repository.js";
import type { RateLimitLease } from "./rate-limit.repository.js";
import type { MeshRequestRecord } from "./mesh-request.repository.js";
import type { A2AMessageRecord, A2ATaskRecord } from "./a2a-task.repository.js";
import type { NewA2AFile } from "./a2a-file.repository.js";
import type { A2ADirectMessageRecord } from "./a2a-direct-message.repository.js";
import type { ExecutionHistoryRecord } from "./execution-history.repository.js";
import type { QueuedChildExecution } from "./child-execution-queue.repository.js";
import type { ExecutionAuditEventRecord } from "./execution-audit-log.repository.js";
import type { OutboundCallRecord } from "./outbound-call.repository.js";

/**
 * The rows of the in-memory defaults of the shared contracts (#265): leases, tree keys and
 * rate-limit slots, windows and pauses. One per application instance in production (in memory nothing is shared
 * between instances); the instances of one test share one (`testWith(App, { instances: 2 })`), so
 * the framework's own implementations are tested across instances. Never written to disk.
 */
export class InMemoryDatabase {
  /** The latest lease of each tree, by `tenantId` + `rootExecutionId` (released ones kept: the epoch). */
  readonly executionLeases = new Map<string, ExecutionLeaseRow>();
  /** Every execution id handed out (#591), by the id alone: never removed, never given twice. */
  readonly executionIds = new Set<string>();
  /** The trees whose cancel was requested (#909), by `tenantId` + `rootExecutionId`: the fence's mark. */
  readonly cancelRequests = new Map<string, CancelRequestRow>();
  /** The keys of each tree, by `tenantId` + `rootExecutionId`. */
  readonly executionTrees = new Map<string, Map<string, ExecutionTreeValue>>();
  /** The slots taken under each key. */
  readonly rateLimitSlots = new Map<string, readonly RateLimitLease[]>();
  /** What is counted under each key of a sliding window (a provider's per-minute calls, tokens). */
  readonly rateLimitWindows = new Map<string, readonly WindowEntry[]>();
  /** Until when each key is paused (a provider's queue after a 429, an open breaker). */
  readonly rateLimitPauses = new Map<string, Date>();
  /** The trusted mesh requests by their key (#398 PR 2). */
  readonly meshRequests = new Map<string, MeshRequestRecord>();
  /** The A2A tasks by `tenantId` + `taskId` (#807). */
  readonly a2aTasks = new Map<string, A2ATaskRecord>();
  /** The accepted A2A messages by `tenantId` + `ownerId` + `messageId` (#807). */
  readonly a2aMessages = new Map<string, A2AMessageRecord>();
  /** The direct A2A messages by `tenantId` + `ownerId` + `messageId` (#860). */
  readonly a2aDirectMessages = new Map<string, A2ADirectMessageRecord>();
  /** The A2A files by `tenantId` + `fileId` (#859), each kept as saved. */
  readonly a2aFiles = new Map<string, NewA2AFile>();
  /** The kept root executions by `tenantId` + `executionId` (#401 PR 1). */
  readonly executionHistory = new Map<string, ExecutionHistoryRecord>();
  /** The queued children by `tenantId` + `executionId` (#333 PR 2), in the order queued. */
  readonly childQueue = new Map<string, QueuedChildExecution>();
  /** The high-water mark of each lease scope (#500), by `scopeKey`. */
  readonly fencedEffectMarks = new Map<string, FencedEffectMarkRow>();
  /** The stored results of fenced effects (#500), by scope, idempotency key and name. */
  readonly fencedEffectResults = new Map<string, FencedEffectResultRow>();
  /** The tail of each scope's fenced-effect transactions (#500): one at a time per scope. */
  readonly fencedEffectLocks = new Map<string, Promise<void>>();
  /** The audit log (#501), in the order saved. */
  readonly executionAuditLog: ExecutionAuditEventRecord[] = [];
  /** The intents of calls that leave the system (#505), by scope, idempotency key and name, in the order recorded. */
  readonly outboundCalls = new Map<string, OutboundCallRecord>();
  /**
   * Each intent's place in the record order (#825: what a page's cursor names), by its row key — a
   * number counted up, never reused, so a pruned intent leaves no gap a cursor could fall into.
   */
  readonly outboundCallOrder = new Map<string, number>();
  /** The highest place given in that order (#825): counted up here, never given again. */
  readonly outboundCallPlaces = { highest: 0 };
}

/** A tree's durable cancel request (#909): when the lease store took it (the `Clock`'s ms). */
export interface CancelRequestRow {
  readonly requestedAt: number;
}

/**
 * The cancel check of the in-memory stores (#909): the key's tree has a durable cancel request and
 * the key is not an undo's — `ExecutionCancelFencedError`, nothing written or sent. After the
 * lease and mark checks and, for an effect, after the key's lookup (a stored result replays).
 */
export function checkInMemoryCancel(database: InMemoryDatabase, key: EffectKey): void {
  if (key.isCompensation === true) return;
  const tree = cancelTreeOf(key);
  if (database.cancelRequests.has(treeKeyOf(tree.tenantId, tree.rootExecutionId)))
    throw ExecutionCancelFencedError.of(key);
}

/**
 * Removes the cancel requests older than `before` (ms) whose tree is over — its lease retired
 * (#520): the fencing stores' retention (#909). Never by age alone: a tree not over (paused longer
 * than the retention, resumed on another instance) keeps its mark, so its writes stay refused.
 */
function prunedCancelRequests(database: InMemoryDatabase, before: number): void {
  for (const [tree, request] of database.cancelRequests)
    if (request.requestedAt < before && database.executionLeases.get(tree)?.isRetired === true)
      database.cancelRequests.delete(tree);
}

/** The fenced effects' retention: their results and marks stored, and the cancel requests, before `before` (ms). */
export function prunedFencedBefore(database: InMemoryDatabase, before: number): void {
  const { fencedEffectMarks: marks, fencedEffectResults: results } = database;
  for (const [row, stored] of results) if (stored.storedAt < before) results.delete(row);
  for (const [scope, mark] of marks) if (mark.storedAt < before) marks.delete(scope);
  prunedCancelRequests(database, before);
}

/** The outbound calls' retention: the intents ended, and the cancel requests, before `before` (ms). */
export function prunedCallsBefore(database: InMemoryDatabase, before: number): void {
  for (const [row, found] of database.outboundCalls)
    // a pending row has no `endedAt`: an invalid date, whose NaN is never `< before`
    if (new Date(found.endedAt ?? Number.NaN).getTime() < before) {
      database.outboundCalls.delete(row);
      database.outboundCallOrder.delete(row);
    }
  prunedCancelRequests(database, before);
}

/** A scope's high-water mark: the highest token written under it, when (the `Clock`'s ms). */
export interface FencedEffectMarkRow {
  readonly highestToken: number;
  readonly storedAt: number;
}

/** A stored fenced-effect result: its JSON, the token it was written under, when. */
export interface FencedEffectResultRow extends StoredKeyFacts {
  readonly scopeKey: string;
  readonly token: number;
  readonly storedAt: number;
  readonly result: string;
}

/** An amount counted under a window's key, at a moment (the framework clock's milliseconds). */
export interface WindowEntry {
  readonly at: number;
  readonly amount: number;
}

/** A tree's lease as stored: the lease and whether its holder released it. */
export interface ExecutionLeaseRow {
  readonly lease: ExecutionLease;
  readonly released: boolean;
  /** Yielded by its holder while it waits for children on any instance (#516); still its own. */
  readonly isYielded?: boolean;
  /**
   * Released by an outbound call's check, expired at its epoch (#508), not by its holder: the next
   * take is a takeover from that holder and epoch (`takenOverFrom`), as of an expired lease.
   */
  readonly isClosedByCheck?: boolean;
  /** Retired by its holder (#520): the work under it is over, no `acquire` gets it again. */
  readonly isRetired?: boolean;
}

/** The row key of a tree: its tenant and its root execution (`\u0000` never occurs in an id). */
export const treeKeyOf = (tenantId: string, rootExecutionId: string): string =>
  `${tenantId}\u0000${rootExecutionId}`;

/**
 * A thread as the key of an in-memory `Map` (internal, #261 S72): its tenant and its id — the
 * same id in two tenants is two threads. The one form every in-memory store of the framework uses;
 * never part of a contract (contracts name a thread by `tenantId` + `threadId`).
 */
export interface ThreadOfTenant {
  readonly tenantId: string;
  readonly threadId: string;
}

export const threadMapKeyOf = ({ tenantId, threadId }: ThreadOfTenant): string =>
  JSON.stringify([tenantId, threadId]);

/**
 * What the built-in infrastructure defaults read from their application instance besides the
 * public `Clock`, `IdGenerator` and `ApplicationContext` (internal, never exported): the memory the
 * in-memory defaults keep their rows in. The app registers it in its container; tests give one
 * database shared by the instances of a test (`testWith(App, { instances: 2 })`).
 */

/** Where the in-memory defaults keep their rows: one per instance, one per test in tests. */
export const IN_MEMORY_DATABASE = new InjectionToken<InMemoryDatabase>("IN_MEMORY_DATABASE");

/**
 * All of them, as the core values every container of an application has — with the application's
 * `FencedEffectSettings` (#500) and `OutboundCallSettings` (#505), public tokens a store of a
 * project injects.
 */
export const INFRASTRUCTURE_TOKENS = [
  IN_MEMORY_DATABASE,
  FencedEffectSettings,
  OutboundCallSettings,
];
