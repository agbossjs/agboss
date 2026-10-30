import type {
  FencedEffectEventOutcome,
  HandOverReason,
  HandOverSite,
  LeaseTakeoverReason,
} from "../../infrastructure/execution-lease-event.repository.js";
import type { NodeEvent } from "./execution-event.js";

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

/**
 * A step was handed over (#501, `onStepHandedOver`): it stopped without failing because its lease
 * was lost or fenced, or the instance stopped — no `.onError`, no undo, its record stays `running`,
 * another instance goes on. A node event: `step` is the step that stopped (its `nodeId`,
 * `visitNumber`, `idempotencyKey`); once per error, at the innermost part of the step that found it
 * (`site`). Identities and tokens only; the same facts are a `HandedOver` row of the lease log,
 * written first.
 */
export interface StepHandedOverEvent extends NodeEvent {
  readonly reason: HandOverReason;
  readonly site: HandOverSite;
  /** The lease scope the step ran under — a fenced write's own scope when it was refused. */
  readonly scopeKey: string;
  /** The instance whose step stopped. */
  readonly holderInstanceId: string;
  /** The token the step held — a refused write's own token. */
  readonly token: number;
  /** The newer token the external system saw, when it said (`ExecutionFencedError.observedToken`). */
  readonly observedToken?: number;
}

/**
 * An instance took a tree's lease over (#501): the recovery sweep, an undo's takeover, a remote
 * child's reclaim or a re-acquire after a yield — and any take whose store names the holder whose
 * lease expired. Its `Takeover` row of the lease log is written first; a throw is only a warning.
 */
export interface OnExecutionLeaseTakeover {
  /** Called once per takeover, after its row is written, before the tree moves on. */
  onExecutionLeaseTakeover(event: ExecutionLeaseTakeoverEvent): Promise<void> | void;
}

/**
 * A step stopped without failing (#501): its lease was lost or an external system fenced its write
 * (`ExecutionFencedError`), or the instance stopped. Once per error, its `HandedOver` row of the
 * lease log written first; a throw is only a warning and never reaches the hand-over.
 */
export interface OnStepHandedOver {
  /** Called once per hand-over, before the moving call rejects. */
  onStepHandedOver(event: StepHandedOverEvent): Promise<void> | void;
}

/**
 * One call of a step's fenced effect (#500, #501 `onFencedEffect`): it ran, its stored result was
 * replayed, it joined a call in flight, or the lease refused it — the step's `step`, the effect's
 * `name`, the lease scope and the call's `token`, never the result. Its `FencedEffect` row of the
 * lease log is written first.
 */
export interface FencedEffectEvent extends NodeEvent {
  readonly name: string;
  readonly scopeKey: string;
  /** The token the call ran under (`fencedEffectKeyOf(…).token`). */
  readonly token: number;
  readonly outcome: FencedEffectEventOutcome;
  /** The token the stored result was first written under, when there is a result. */
  readonly writtenToken?: number;
  /** The newer token the store saw, when it refused the call. */
  readonly observedToken?: number;
  /** The instance that made the call. */
  readonly holderInstanceId: string;
}

/**
 * A step's fenced effect was called (#501): ran, replayed, joined or refused. Its row of the lease
 * log is written first; a throw is only a warning and never reaches the effect or its step.
 */
export interface OnFencedEffect {
  /** Called once per call of `saveResultIfAbsent`, after its outcome is known. */
  onFencedEffect(event: FencedEffectEvent): Promise<void> | void;
}
