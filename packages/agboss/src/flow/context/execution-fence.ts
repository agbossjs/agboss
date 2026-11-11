import { ExecutionFencedError } from "../../app/lease-lost.js";
import { ExecutionContextUnavailableError } from "./errors.js";
import type { Frame, FrameLease } from "./frame.js";

/**
 * The fence of the current step (#471): the lease it runs under, as an external system needs it to
 * refuse a write of an instance that lost the lease — `scopeKey` + `token` written with the step's
 * `idempotencyKey` in one transaction, `incoming >= highest` accepted, `incoming < highest` refused
 * (`fence.fencedError(highest)`). Exactly-once only when the external system checks both atomically;
 * the framework runs a step at least once. Wiki → Several-instances.
 */
export interface ExecutionFence {
  /**
   * `${encodeURIComponent(tenantId)}:${encodeURIComponent(leaseExecutionId)}` — exactly one `:`;
   * the key of the external high-water mark. A public format, never changes.
   */
  readonly scopeKey: string;
  readonly tenantId: string;
  /**
   * The execution whose lease the step runs under: the root (and its `ParentInstance` children,
   * `ThisWorkflow` levels), or a `ChildPlacement.AnyInstance` child itself.
   */
  readonly leaseExecutionId: string;
  /**
   * The lease's `token`: a counter of this one lease key (1, 2, …), not a cluster-wide
   * sequence — it rises with every take (a recovery, a resume, the reclaim after remote children).
   */
  readonly token: number;
  /**
   * Until when the holder trusts its lease (#335, #533): the time its store said is left, less a
   * 1 s margin, counted from when it sent the request on its monotonic and its wall clock (the
   * earlier ends it) — shown here on the wall clock, for reading.
   */
  readonly trustedUntil: Date;
  /**
   * Synchronous, no I/O: the lease lost, or its trust ran out (`trustedUntil`, counted on the
   * holder's monotonic and wall clocks) → expires the lease here first (its signal aborts), then
   * throws `ExecutionLeaseLostError`.
   */
  assertHeld(): void;
  /**
   * Renews the lease in the store now: confirmed → the lease's after-renewal checks run (#360: a
   * cancel requested elsewhere is seen before an irreversible call) and it resolves; anything else
   * — lost, any store error, a transient one too — aborts the lease here and rejects with
   * `ExecutionLeaseLostError`: a hand-over, the tree goes on elsewhere once the lease expires.
   */
  renewNow(): Promise<void>;
  /** The error a step throws when the external system refused its write (it saw `observedToken`). */
  fencedError(observedToken?: number): ExecutionFencedError;
}

/** How the view finds the frame of each read: the current one, open (`live-context.ts`). */
export type FrameOf = (field: string) => Frame;

const FIELD = "executionContext.fence";

/** The frame's lease, held now; no lease, or one yielded meanwhile → why it is unavailable. */
function heldLeaseOf(frameOf: FrameOf, consumer: string, member: string): FrameLease {
  const field = `${FIELD}.${member}`;
  const { lease } = frameOf(field).execution;
  const read = { consumer, field };
  if (lease === undefined)
    throw ExecutionContextUnavailableError.noFence(
      read,
      "where no lease is held (a reply interpreter, a budget's maxSpend(), an eval judge, a tool called on its own)",
    );
  if (lease.isYielded || lease.token === undefined)
    throw ExecutionContextUnavailableError.noFence(
      read,
      "while its lease is yielded for remote children",
    );
  return lease;
}

/**
 * The live fence of `consumer`'s context: every member reads the current frame when it is used, so
 * a fence kept past its step (a destructured `fence` in a stray promise) refuses, never reads
 * another frame's lease.
 */
export const liveFenceOf = (frameOf: FrameOf, consumer: string): ExecutionFence =>
  fenceOver((member) => heldLeaseOf(frameOf, consumer, member));

/** A fence whose every member reads the lease `leaseOf` gives at that moment. */
export function fenceOver(leaseOf: (member: string) => FrameLease): ExecutionFence {
  const tokenOf = (held: FrameLease): number => held.token ?? 0;
  return Object.freeze({
    get scopeKey(): string {
      return leaseOf("scopeKey").scopeKey;
    },
    get tenantId(): string {
      return leaseOf("tenantId").tenantId;
    },
    get leaseExecutionId(): string {
      return leaseOf("leaseExecutionId").leaseExecutionId;
    },
    get token(): number {
      return tokenOf(leaseOf("token"));
    },
    get trustedUntil(): Date {
      return new Date(leaseOf("trustedUntil").trustedUntil);
    },
    assertHeld(): void {
      leaseOf("assertHeld").assertHeld();
    },
    async renewNow(): Promise<void> {
      // a fence that cannot be read rejects, as a renewal that failed does
      await leaseOf("renewNow").renewNow();
    },
    fencedError(observedToken?: number): ExecutionFencedError {
      const held = leaseOf("fencedError");
      return new ExecutionFencedError({
        scopeKey: held.scopeKey,
        token: tokenOf(held),
        observedToken,
      });
    },
  });
}

/** The fence of an ancestor's context (#263): never — fence with the current context's lease. */
export function ancestorFenceRead(consumer: string): never {
  throw ExecutionContextUnavailableError.noFence(
    { consumer, field: FIELD },
    "of an ancestor execution: an ancestor of a child on any instance is rebuilt elsewhere and its lease may be yielded — read the fence of the current context",
  );
}
