import type { LeaseTakeoverReason } from "../../infrastructure/execution-lease-event.repository.js";

/**
 * An instance took a tree's lease over (#501, `onExecutionLeaseTakeover`): who took it at which
 * token, from whom when the lease store names the holder whose lease expired, and why. Like
 * `ExecutionRejectedEvent` it names no workflow or thread — a lease belongs to a tree, not to one
 * execution's step. Identities and tokens only; the same facts are a `Takeover` row of the lease
 * log (`app.leaseEventsOf`), written before the observers hear of it.
 */
export interface ExecutionLeaseTakeoverEvent {
  readonly tenantId: string;
  /** The tree's root. */
  readonly rootExecutionId: string;
  /** The execution whose lease it is: the root, or a `ChildPlacement.AnyInstance` child. */
  readonly leaseExecutionId: string;
  /** `executionContext.fence.scopeKey` of the lease. */
  readonly scopeKey: string;
  /** The new holder's token (`executionContext.fence.token` from now on). */
  readonly token: number;
  /** The instance that took the lease. */
  readonly holderInstanceId: string;
  /** The holder whose lease had expired; none after a release, or when the store does not say. */
  readonly previousHolderInstanceId?: string;
  readonly previousToken?: number;
  /** The tree's head checkpoint when the lease was taken, where the take reads it. */
  readonly checkpointId?: string;
  readonly reason: LeaseTakeoverReason;
}
