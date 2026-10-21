import type { InputOf, NoOutput, OutputOf, RouterAnswerOf } from "./generated-types.js";

/**
 * The handler contracts of the v2 nodes (#270 → one handler contract): `implements <Kind>Handler<Self>`
 * and the method takes `InputOf<Self>` — generated, never written by hand, so it cannot disagree
 * with the decorator or the graph. Before generation `InputOf<Self>` is `MissingGeneratedTypes`.
 * Each method is a function-typed property (#120 PR 4): checked with strict variance on the
 * decorator line, against the class's own generated types — `implements` is documentation.
 */

/** What an action's `execute` resolves to: its output, nothing without `output`. */
export type ActionResult<TOutput> = [TOutput] extends [NoOutput] ? Promise<void> : Promise<TOutput>;

/**
 * `@Action`: `execute(input)` — `Promise<OutputOf<Self>>`, `Promise<void>` without `output`. No run
 * context (#272 S16): project code gets the run through #280's `ExecutionContext`.
 */
export interface ActionHandler<TSelf> {
  readonly execute: (input: InputOf<TSelf>) => ActionResult<OutputOf<TSelf>>;
}

/** `@WorkflowFinish` with `input`: builds the execution's output. */
export interface FinishHandler<TSelf> {
  readonly finish: (input: InputOf<TSelf>) => OutputOf<TSelf> | Promise<OutputOf<TSelf>>;
}

/**
 * `@Router({ decidedBy: DecidedBy.Code })` (#280): `route(input)` returns the target to take —
 * `Route<Self>` after `.chooseOne(…)`, a list after a launch (#273). No model call; the execution
 * comes through `deps: [ExecutionContext]`.
 */
export interface RouterHandler<TSelf> {
  readonly route: (input: InputOf<TSelf>) => RouterAnswerOf<TSelf> | Promise<RouterAnswerOf<TSelf>>;
}

/** A tool: its input is the plain DTO of the model's call, not `Produced` (#270, Q53). */
export interface ToolHandler<TSelf> {
  readonly run: (input: InputOf<TSelf>) => Promise<OutputOf<TSelf>>;
}
