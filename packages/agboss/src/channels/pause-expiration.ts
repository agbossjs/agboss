import type { ChannelAnswerOf } from "../flow/generated-types.js";
import type { ChannelAsk } from "./channel-handler.js";

/**
 * What a pause's deadline means (#941, D2): a channel may decide it —
 * `PauseExpiration.fail()` (the step fails with `PauseExpiredError`) or
 * `PauseExpiration.decide(answer)` (the step goes on with that answer, recorded as answered by the
 * expiry). Without `onPauseExpired` a channel's pause fails. The expiry is the framework's call
 * once the deadline passed, never the channel's.
 */

/** The two things an expiry can mean. */
export enum PauseExpirationKind {
  /** The step fails with `PauseExpiredError`. */
  Fail = "fail",
  /** The step goes on with the channel's answer. */
  Decide = "decide",
}

/** The expiry fails the step. */
export interface FailExpiration {
  readonly kind: PauseExpirationKind.Fail;
}

/** The expiry answers the pause. */
export interface DecideExpiration<TAnswer> {
  readonly kind: PauseExpirationKind.Decide;
  readonly answer: TAnswer;
}

/** What `onPauseExpired` returns for a channel of `TRole`: the role's answer type checks `decide`. */
export type PauseExpiration<TRole> = FailExpiration | DecideExpiration<ChannelAnswerOf<TRole>>;

const FAIL: FailExpiration = Object.freeze({ kind: PauseExpirationKind.Fail });

/** The only way to build an expiry's decision. */
export const PauseExpiration = {
  /** The pause's step fails with `PauseExpiredError`: `.onError(PauseExpiredError, …)` takes it. */
  fail(): FailExpiration {
    return FAIL;
  },
  /**
   * The step goes on with `answer`, validated like a resume's, recorded as answered by the expiry
   * (`answeredBy` is the channel's name). An approval decided `approved: true` runs its tool with
   * no person having looked: the channel chooses that.
   */
  decide<TAnswer>(answer: TAnswer): DecideExpiration<TAnswer> {
    return Object.freeze({ kind: PauseExpirationKind.Decide, answer });
  },
} as const;

/** Whether a value `onPauseExpired` returned is an expiry decision (a JS channel is checked at run time). */
export function isPauseExpiration(
  value: unknown,
): value is FailExpiration | DecideExpiration<unknown> {
  if (typeof value !== "object" || value === null || !("kind" in value)) return false;
  if (value.kind === PauseExpirationKind.Fail) return true;
  return value.kind === PauseExpirationKind.Decide && "answer" in value;
}

/**
 * Optional on a channel (D2): what the expiry of a pause it sent means. Called under the tree's
 * lease in the pause's frame, once per expiry — more than once only after a crash before its
 * decision was recorded, so it must have no effects of its own beyond reading. `ask` is what `send`
 * got (the display-masked ask).
 */
export interface PauseExpiryHandler<TRole> {
  onPauseExpired(ask: ChannelAsk<TRole>): PauseExpiration<TRole> | Promise<PauseExpiration<TRole>>;
}
