import type { ExecutionLease } from "./execution-lease.repository.js";
import type { ExecutionTreeValue } from "./execution-tree.repository.js";
import type { RateLimitLease } from "./rate-limit.repository.js";
import type { MeshRequestRecord } from "./mesh-request.repository.js";
import type { ExecutionHistoryRecord } from "./execution-history.repository.js";
import type { QueuedChildExecution } from "./child-execution-queue.repository.js";
import type { ExecutionLeaseEventRecord } from "./execution-lease-event.repository.js";
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
  /** The lease log (#501), in the order saved. */
  readonly executionLeaseEvents: ExecutionLeaseEventRecord[] = [];
  /** The intents of calls that leave the system (#505), by scope, idempotency key and name, in the order recorded. */
  readonly outboundCalls = new Map<string, OutboundCallRecord>();
}

/** A scope's high-water mark: the highest token written under it, when (the `Clock`'s ms). */
export interface FencedEffectMarkRow {
  readonly highestToken: number;
  readonly storedAt: number;
}

/** A stored fenced-effect result: its JSON, the token it was written under, when. */
export interface FencedEffectResultRow {
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
