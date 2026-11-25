import type { Usd } from "../../units/index.js";
import type { NodeEvent } from "./execution-event.js";

/**
 * An arbiter starts judging one answer of a quorum launch (#1283, `onArbiterStart`): in the frame of
 * the branch that gave it, before the arbiter's code or model looks at it. Names only, never the answer.
 */
export interface ArbiterStartEvent extends NodeEvent {
  /** The `@Arbiter`'s name. */
  readonly arbiter: string;
  /** The `name` of the branch's target whose answer is judged. */
  readonly target: string;
  /** Whether the arbiter is code (`@Arbitrate` methods), else a model judging by `criteria`. */
  readonly isCode: boolean;
}

/** How a judging ended. */
export enum ArbiterOutcome {
  /** The arbiter accepted the answer. */
  Accepted = "accepted",
  /** The arbiter rejected it. */
  Rejected = "rejected",
  /** The launch was decided first: the answer does not count, whatever was asked. */
  Abandoned = "abandoned",
  /** It ended with no verdict: the arbiter failed (`StepError.Arbiter`), a limit was reached or the execution was cancelled. */
  NoVerdict = "no-verdict",
}

/** An arbiter ended judging (`onArbiterEnd`): once per `onArbiterStart`, with what it spent. */
export interface ArbiterEndEvent extends ArbiterStartEvent {
  readonly outcome: ArbiterOutcome;
  /** What its model calls cost (`0` for a code arbiter without a model); the spend is already counted. */
  readonly costUsd: Usd;
}
