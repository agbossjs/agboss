import type { PauseActor } from "../../channels/pause-contexts.js";
import type { Class } from "../../components/injection.js";
import type { PauseOutputOf } from "../../flow/generated-types.js";

/**
 * The pauses a case answers (#1328d, `@agboss/core/eval`): after a turn pauses, each scripted answer
 * resolves the open pause of its target — `answerPause(Approval, { approved: true })` with a
 * decision, `replyToPause(Approval, "ok, but only half")` with free text its channel interpreter
 * reads — in the order listed, then the turn goes on. Shared one to one with `@agboss/core/testing`.
 */

/** Who answers: the actor a `ThreadOwner` pause is checked against (`actor.id`). */
export interface EvalPauseOptions {
  readonly actor?: PauseActor | undefined;
}

/** One scripted answer of a pause. */
export type EvalPauseScript =
  | {
      readonly target: Class;
      readonly decision: unknown;
      readonly reply?: never;
      readonly actor?: PauseActor | undefined;
    }
  | {
      readonly target: Class;
      readonly reply: string;
      readonly decision?: never;
      readonly actor?: PauseActor | undefined;
    };

/** Answers the open pause of `target` with its decision, typed by the target's output. */
export function answerPause<const TTarget extends Class>(
  target: TTarget,
  decision: PauseOutputOf<InstanceType<TTarget>>,
  options: EvalPauseOptions = {},
): EvalPauseScript {
  return Object.freeze({ target, decision, ...options });
}

/** Answers the open pause of `target` with a free-text reply, read by its channel interpreter. */
export function replyToPause(
  target: Class,
  reply: string,
  options: EvalPauseOptions = {},
): EvalPauseScript {
  return Object.freeze({ target, reply, ...options });
}
