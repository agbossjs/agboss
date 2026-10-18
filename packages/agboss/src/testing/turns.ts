import type { Class } from "../components/injection.js";
import type { DtoClass } from "../dto/types.js";
import type { ModelFailure } from "../models/model-failure.js";
import type { Milliseconds, Usd } from "../units/index.js";

/**
 * The turns a script holds (`mockLlm(X).thenReturn(…)`): what one model call answers. Each is a
 * named shape; the answer and route turns carry, at the type level only, what they give — so
 * `thenReturn` checks them against the generated `ProducerOutputOf<Agent>` / `RouterAnswerOf<Router>`
 * (#262 AC8). At run time only `kind` and the data matter.
 */

/** Optional parts of a scripted answer (text or structured). */
export interface AnswerDetails {
  /** What the call cost (priced as output tokens of the agent's model): the execution's spend. */
  readonly cost?: Usd;
  /** The answer hit the output limit (`finish_reason: "length"`). */
  readonly truncated?: boolean;
}

/** Optional parts of a scripted router decision. */
export interface DecisionDetails {
  readonly reason?: string;
  /** Probability of the choice (Jev reports one; guards read it). Default 1. */
  readonly confidence?: number;
  readonly cost?: Usd;
}

/** A scripted answer to one decision question: P(yes) (`noul`), an option (`choice`), a level's index or text (`score`). */
export type ScriptedAnswer = number | string;

/** Optional parts of a scripted decision (`decideWith`). */
export interface DecideDetails {
  /** What the decision cost (the Decisions API's `usage.cost`). */
  readonly cost?: Usd;
}

/** Never set: what an answer turn gives, for the compiler only. */
declare const answerGiven: unique symbol;
/** Never set: the targets a route turn names, for the compiler only. */
declare const routeGiven: unique symbol;

/** What an answer turn gives: one value of a class, or a list of them. */
export interface AnswerGiven<TValue, TIsList extends boolean> {
  readonly value: TValue;
  readonly isList: TIsList;
}

/** A text reply: `replyWith("3 jobs found")`. */
export interface ReplyTurn {
  readonly kind: "reply";
  readonly text: string;
  readonly details: AnswerDetails;
}

/** A structured answer through the answer tool of a class (#272 S6): `replyWith(OfferDraftDto, {…})`. */
export interface AnswerTurn<TValue = unknown, TIsList extends boolean = boolean> {
  readonly kind: "answer";
  readonly dto: DtoClass;
  /** The fields, or the list of values of a list output. */
  readonly value: unknown;
  readonly details: AnswerDetails;
  readonly [answerGiven]?: AnswerGiven<TValue, TIsList>;
}

/** A call of one of the agent's tools: `callTool(SaveShortlist, { jobs: ["Acme"] })`. */
export interface ToolCallTurn {
  readonly kind: "tool-call";
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
}

/** What a model router chose: `routeTo(ProfilerAgent)`; before a launch, the targets it launches. */
export interface RouteTurn<TTargets extends readonly unknown[] = readonly Class[]> {
  readonly kind: "route";
  readonly targets: readonly Class[];
  readonly details: DecisionDetails;
  readonly [routeGiven]?: TTargets;
}

/** A decision model's answers by question id: `decideWith({ grounded: 0.9 })`. */
export interface DecideTurn {
  readonly kind: "decide";
  readonly answers: Readonly<Record<string, ScriptedAnswer>>;
  readonly details: DecideDetails;
}

/** The model call fails: `failWith(ModelFailure.Timeout)`. */
export interface FailureTurn {
  readonly kind: "failure";
  readonly failure: ModelFailure;
}

/**
 * The call takes this long on the test's clock before the next turn answers it:
 * `thenReturn(waitFor(seconds(31)), replyWith("late"))` — the call waits until `clock.advance`
 * reaches it (or its signal aborts); it is not a call of its own.
 */
export interface WaitTurn {
  readonly kind: "wait";
  readonly delay: Milliseconds;
}

/** One scripted step: a text, an answer, a tool call, a route, a decision, a failure or a wait. */
export type ScriptedTurn =
  ReplyTurn | AnswerTurn | ToolCallTurn | RouteTurn | DecideTurn | FailureTurn | WaitTurn;

/** A turn of a kind. */
export type TurnOf<TKind extends ScriptedTurn["kind"]> = Extract<ScriptedTurn, { kind: TKind }>;

/** What one model call answers: its turn, after waiting `delay` on the clock (0: none). */
export interface ScriptedCall {
  readonly turn: Exclude<ScriptedTurn, WaitTurn>;
  readonly delay: number;
}
