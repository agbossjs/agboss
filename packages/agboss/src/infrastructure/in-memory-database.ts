import type { ExecutionLease } from "./execution-lease.repository.js";
import type { ExecutionTreeValue } from "./execution-tree.repository.js";
import type { RateLimitLease } from "./rate-limit.repository.js";
import type { MeshRequestRecord } from "./mesh-request.repository.js";

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
