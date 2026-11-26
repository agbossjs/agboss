import type { PauseOutputOf } from "../flow/generated-types.js";
import type { Class } from "../components/injection.js";
import type { Milliseconds, WorkingDuration } from "../units/index.js";
import type { ExpiredContext } from "./pause-contexts.js";

/**
 * What a pause's deadline means (#941, D2, #1310): its `@ToolApproval` or `@ExternalTask` decides it
 * in `onExpired` — `PauseExpiration.fail()` (the step fails with `StepError.PauseExpired`),
 * `PauseExpiration.decide(answer)` (the step goes on with that answer, recorded as answered by the
 * expiry) or `PauseExpiration.reassign(…)` (the pause waits on under a new deadline). Without
 * `onExpired` a target's pause fails. The expiry is the framework's call once the deadline passed,
 * never the channel's: a reassignment is domain-only, it names no `@Channel`.
 */

/** The two things an expiry can mean. */
export enum PauseExpirationKind {
  /** The step fails with `StepError.PauseExpired`. */
  Fail = "fail",
  /** The step goes on with the channel's answer. */
  Decide = "decide",
  /** The pause moves to other assignees with a new deadline; the step keeps waiting. */
  Reassign = "reassign",
}

/** The expiry fails the step. */
export interface FailExpiration {
  readonly kind: PauseExpirationKind.Fail;
}

/** The expiry answers the pause. */
export interface DecideExpiration<out TAnswer> {
  readonly kind: PauseExpirationKind.Decide;
  readonly answer: TAnswer;
}

/**
 * The expiry hands the pause on (#1310a, #1307d): to other assignees, another channel or another
 * target, under a new deadline. A pause that stays with its target and channel is changed in place
 * (its id and `externalRef` kept); one moved is a new pause the new channel is sent. It names no
 * `@Channel`: the new target's only one, or its `@ChannelSelector` (which reads the escalation in
 * `ctx.trail`), carries it. The rules are `app.reassignPause`'s, but its `permitReassign` is not
 * asked (no outside actor asks; `escalatesTo` bounds the move): the target must be of the same kind and DTOs, the chain's
 * `escalationLimits` hold; a reassignment that cannot be made expires the pause as `fail()`.
 */
export interface ReassignExpiration {
  readonly kind: PauseExpirationKind.Reassign;
  /** The `@ToolApproval` or `@ExternalTask` it waits under now; absent: its own. */
  readonly target?: Class;
  /**
   * Who it is for now: one to 100 key's texts, none twice. Absent: the target's `assign` decides when
   * it has one, otherwise a pause that stays with its target keeps them.
   */
  readonly assignees?: readonly string[];
  /** How long it waits from now (`seconds(1)` at least); absent: the target's `resolveTimeout` or its `timeout`. */
  readonly timeout?: Milliseconds | WorkingDuration;
  /** Why, as the chain of custody keeps it (masked by the pause's workflow's PII policy). */
  readonly reason?: string;
}

/**
 * What `onExpired` returns for a target `TTarget`: its output type checks `decide`. Covariant in
 * `TTarget` (a union alias takes no `out` annotation: it is inferred from the covariant
 * `DecideExpiration<out TAnswer>`); bare `PauseExpiration` is `fail()` or `reassign(…)` only.
 */
export type PauseExpiration<TTarget = never> =
  FailExpiration | DecideExpiration<PauseOutputOf<TTarget>> | ReassignExpiration;

const FAIL: FailExpiration = Object.freeze({ kind: PauseExpirationKind.Fail });

/** The only way to build an expiry's decision. */
export const PauseExpiration = {
  /** The pause's step fails with `StepError.PauseExpired`: `.onError(StepError.PauseExpired, …)` takes it. */
  fail(): FailExpiration {
    return FAIL;
  },
  /**
   * The step goes on with `answer`, validated like a resume's, recorded as answered by the expiry
   * (no `actor`, no `answeredBy`: no person answered). An approval decided `approved: true` runs its
   * tool with no person having looked: the target chooses that.
   */
  decide<TAnswer>(answer: TAnswer): DecideExpiration<TAnswer> {
    return Object.freeze({ kind: PauseExpirationKind.Decide, answer });
  },
  /**
   * The pause goes on waiting under a new deadline, for other assignees, on another channel or
   * under another target (`ReassignExpiration`): never past the run's or a quorum's deadline, nor the
   * chain's `escalationLimits`. A pause whose deadline is the run's or a quorum's is not reassigned:
   * it fails.
   */
  reassign(options: {
    readonly target?: Class;
    readonly assignees?: readonly string[];
    readonly timeout?: Milliseconds | WorkingDuration;
    readonly reason?: string;
  }): ReassignExpiration {
    return Object.freeze({ kind: PauseExpirationKind.Reassign, ...options });
  },
} as const;

/** Whether a value `onExpired` returned is an expiry decision (a JS target is checked at run time). */
export function isPauseExpiration(
  value: unknown,
): value is FailExpiration | DecideExpiration<unknown> | ReassignExpiration {
  if (typeof value !== "object" || value === null || !("kind" in value)) return false;
  if (value.kind === PauseExpirationKind.Fail || value.kind === PauseExpirationKind.Reassign)
    return true;
  return value.kind === PauseExpirationKind.Decide && "answer" in value;
}

/**
 * Optional on a `@ToolApproval` or `@ExternalTask` (D2, #1310): what the expiry of one of its
 * pauses means. Called under the tree's lease in the pause's frame, once per expiry — more than once
 * only after a crash before its decision was recorded, so it must have no effects of its own beyond
 * reading. A target without it fails its expired pauses (`PauseExpiration.fail()`).
 */
export interface PauseExpiryHandler<TTarget> {
  onExpired(
    ctx: ExpiredContext<TTarget>,
  ): PauseExpiration<TTarget> | Promise<PauseExpiration<TTarget>>;
}
