import { cancelFencedOf, pauseFencedOf, stopFencedOf } from "../app/cancel-fenced.js";
import { InjectionToken } from "../components/injection.js";
import { InterruptMode } from "../app/interrupt-types.js";
import type { EffectKey } from "./effect-key.js";
import { cancelTreeOf } from "./issued-keys.js";
import { OutboundMasking } from "../app/outbound-masking.js";
import type { StoredKeyFacts } from "./fenced-effect-key.js";
import type { ThreadStatusTransition } from "../turns/index.js";
import type { ExecutionLease } from "./execution-lease.repository.js";
import type { ExecutionTreeValue } from "./execution-tree.repository.js";
import type { RateLimitLease } from "./rate-limit.repository.js";
import type { MeshRequestRecord } from "./mesh-request.repository.js";
import type { A2AMessageRecord, A2ATaskRecord } from "./a2a-task.repository.js";
import type { FileOwnerCompletion, NewFile } from "./file.repository.js";
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
  /**
   * The latest lease of each tree, by `tenantId` + `rootExecutionId` (released ones kept: the epoch),
   * with the tree's cancel mark (#909, #1117: `cancelRequestedAt`, kept for good).
   */
  readonly executionLeases = new Map<string, ExecutionLeaseRow>();
  /** Every execution id handed out (#591), by the id alone: never removed, never given twice. */
  readonly executionIds = new Set<string>();
  /** The status history of each thread (#1341d), by `tenantId` + `threadId`, oldest first. */
  readonly statusTransitions = new Map<string, ThreadStatusTransition[]>();
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
  readonly a2aFiles = new Map<string, NewFile>();
  /** The owners of files whose execution has ended, by `tenantId` + `ownerId` (#1316). */
  readonly fileCompletions = new Map<string, FileOwnerCompletion>();
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
  /**
   * When each ended intent may be removed (ms; `null` = never), by its row key: set when it ended
   * (`markCompleted` / `markFailed`), cleared when a new attempt claims it. A pending intent has no
   * entry — it is never removed.
   */
  readonly outboundCallExpiries = new Map<string, number | null>();
}

/**
 * The cancel check of the in-memory stores (#909): the key's tree — its root's lease row — carries
 * the cancel mark (#1117: `cancelRequestedAt`, never lifted) and the key is not an undo's —
 * `ExecutionError.CancelFenced`, nothing written or sent. After the lease and mark checks and, for
 * an effect, after the key's lookup (a stored result replays).
 */
export function checkInMemoryCancel(database: InMemoryDatabase, key: EffectKey): void {
  const tree = cancelTreeOf(key);
  const row = database.executionLeases.get(treeKeyOf(tree.tenantId, tree.rootExecutionId));
  checkFence(row, key, tree.rootExecutionId);
  // a cancelled tree's undo runs; a stopped one (`Immediate`) has none, and nothing of it is written
  if (row?.cancelRequestedAt === undefined && row?.stopMode === InterruptMode.Immediate)
    throw stopFencedOf(key);
  if (key.isCompensation === true) return;
  if (row?.cancelRequestedAt !== undefined) throw cancelFencedOf(key);
}

/**
 * A pause fenced the root lease through a token (#1341c): its holder at or below it is stale, and so
 * is every child of the tree while the root's current token is the fenced one — a child's own token
 * says nothing of the pause, the root row (`key.rootExecutionId`) is where every write of the tree
 * looks. A lease taken at a higher token (an unpause, a cancel's unwind) is not fenced.
 */
function checkFence(row: ExecutionLeaseRow | undefined, key: EffectKey, root: string): void {
  const fenced = row?.fencedThroughToken;
  if (row === undefined || fenced === undefined) return;
  const isStale = key.leaseExecutionId === root ? key.token <= fenced : fenced >= row.lease.token;
  if (isStale) throw pauseFencedOf(key);
}

/** Whether an expiry (ms; `null` = never) has come at `now`: `null` never has. */
const isDue = (expiresAt: number | null | undefined, now: number): boolean =>
  expiresAt !== undefined && expiresAt !== null && expiresAt <= now;

/**
 * The later of two expiries (ms; `null` = never, which is later than any date): what a scope's
 * mark keeps when another key is written under it.
 */
export const laterExpiry = (
  known: number | null | undefined,
  given: number | null,
): number | null =>
  known === undefined ? given : known === null || given === null ? null : Math.max(known, given);

/**
 * The fenced effects' expiry: their results and marks whose `expiresAt` has come at `now` (ms); the
 * rows removed. A tree's cancel mark is never pruned (#1117): it is on the lease row, kept as the
 * lease rows are.
 */
export function prunedFencedAt(database: InMemoryDatabase, now: number): number {
  const { fencedEffectMarks: marks, fencedEffectResults: results } = database;
  let removed = 0;
  for (const [row, stored] of results)
    if (isDue(stored.expiresAt, now)) {
      results.delete(row);
      removed += 1;
    }
  for (const [scope, mark] of marks)
    if (isDue(mark.expiresAt, now)) {
      marks.delete(scope);
      removed += 1;
    }
  return removed;
}

/**
 * The outbound calls' expiry: the intents that ended and whose `expiresAt` has come at `now` (ms);
 * never a pending one (it has none), no cancel mark (#1117). The intents removed.
 */
export function prunedCallsAt(database: InMemoryDatabase, now: number): number {
  let removed = 0;
  for (const [row, expiresAt] of database.outboundCallExpiries)
    if (isDue(expiresAt, now)) {
      database.outboundCalls.delete(row);
      database.outboundCallOrder.delete(row);
      database.outboundCallExpiries.delete(row);
      removed += 1;
    }
  return removed;
}

/** A scope's high-water mark: the highest token written under it, when (the `Clock`'s ms), and until when. */
export interface FencedEffectMarkRow {
  readonly highestToken: number;
  readonly storedAt: number;
  /** The latest expiry of every key written under the scope (ms), `null` = never. */
  readonly expiresAt: number | null;
}

/** A stored fenced-effect result: its JSON, the token it was written under, when, and until when. */
export interface FencedEffectResultRow extends StoredKeyFacts {
  readonly scopeKey: string;
  readonly token: number;
  readonly storedAt: number;
  /** When it may be removed (ms), `null` = never. */
  readonly expiresAt: number | null;
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
  /**
   * When the tree's cancel was requested (#909, the `Clock`'s ms): the fence's mark, set once and
   * kept by every later write of the row (#1117) — no lease operation and no retention lifts it. A
   * cancel before the tree's first acquire writes a seed row: token 0, released, never held.
   */
  readonly cancelRequestedAt?: number;
  /**
   * How the tree's stop was requested (#1341b, `app.stop`): kept by every later write of the row like
   * the cancel mark, escalated from `AfterStep` to `Immediate`, never lowered; `Immediate` fences the
   * tree's new writes (`checkInMemoryCancel`).
   */
  readonly stopMode?: InterruptMode;
  /** Paused from outside (#1341c, `app.pause`), with its reason: set by `requestPause`, lifted by `unpause`. */
  readonly externalPause?: { readonly reason?: string; readonly mode: InterruptMode };
  /**
   * The highest token of the root lease an `Immediate` pause fenced (#1341c): only ever raised
   * (`GREATEST`), never cleared; a write at that token or below is refused (`checkInMemoryCancel`).
   */
  readonly fencedThroughToken?: number;
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
 * `OutboundMasking` (#505): whether a call's request is stored only masked.
 */
export const INFRASTRUCTURE_TOKENS = [IN_MEMORY_DATABASE, OutboundMasking];
