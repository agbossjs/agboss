import type { Class } from "../../components/injection.js";
import type { ExecutionInputOf, ExecutionOptionsOf, OutputOf } from "../../flow/generated-types.js";
import type { JudgeEvalCheck } from "./checks.js";
import type { EvalToolExpectations } from "./tool-expectations.js";

/**
 * The cases of an eval suite (#396): each one a thread of its own — `history` written into it
 * without running (past turns the memory and its compaction read), then `turns` run on it in order
 * through the suite's start; the checks judge the last turn. `tenant` / `execution` are the
 * execution's context values, typed and validated like `app.execute`'s (`eval.case-invalid`).
 */

/** One turn a case runs: the input of the suite's start (`app.execute(Start, input)`). */
export interface EvalTurn<TInput = unknown> {
  readonly input: TInput;
}

/** One past turn written into the case's thread, not run: a start's input and a finish's output. */
export interface EvalPastTurn {
  readonly start: Class;
  readonly input: unknown;
  readonly finish: Class;
  readonly output: unknown;
}

/** One case of a suite, as `evalCase(…)` builds it. */
export interface EvalCase {
  /** Unique in the suite (`[eval.duplicate-case]`): the case's key in reports and baselines. */
  readonly name: string;
  /** The tenant's values (`app.execute(…, { tenant })`). */
  readonly tenant?: unknown;
  /** The execution's own context values (`app.execute(…, { execution })`). */
  readonly execution?: unknown;
  /** Past turns written into the thread before the first turn, oldest first. */
  readonly history?: readonly EvalPastTurn[];
  /** The turns run on the thread, in order; at least one. The checks judge the last. */
  readonly turns: readonly EvalTurn[];
  /** What the run's tool calls must and must not be (`checkTrajectory()`). */
  readonly tools?: EvalToolExpectations;
  /** Judges of this case only, after the suite's checks. */
  readonly judges?: readonly JudgeEvalCheck[];
  /** Rewordings of the last turn (`--metamorphic`): the same tools, the same key arguments. */
  readonly variants?: readonly EvalTurn[];
}

/**
 * A value as a case writes it: read-only all the way down — `evalCase(…)` keeps its literals
 * (`plan: "pro"`), so its lists are read-only tuples.
 */
export type EvalValueOf<TValue> = TValue extends readonly (infer TItem)[]
  ? readonly EvalValueOf<TItem>[]
  : TValue extends object
    ? { readonly [TKey in keyof TValue]: EvalValueOf<TValue[TKey]> }
    : TValue;

/** The turns of a case for a start: its input, typed by the generated `.agboss/types.d.ts`. */
interface EvalTurnsOf<TStart> {
  readonly turns: readonly EvalTurn<EvalValueOf<ExecutionInputOf<TStart>>>[];
  readonly variants?: readonly EvalTurn<EvalValueOf<ExecutionInputOf<TStart>>>[];
}

/** `tenant` / `execution` of a case for a start: required where its application declares them. */
type EvalContextsOf<TStart> = {
  readonly [TKey in keyof Pick<ExecutionOptionsOf<TStart>, "tenant" | "execution">]: EvalValueOf<
    ExecutionOptionsOf<TStart>[TKey]
  >;
};

/**
 * A case as a suite of `TStart` (an instance of its start) takes it: its turns are the start's
 * input, `tenant` / `execution` its application's context values — required where the application
 * declares its own context classes, as at `app.execute`.
 */
export type EvalCaseOf<TStart> = Omit<EvalCase, "tenant" | "execution" | "turns" | "variants"> &
  EvalContextsOf<TStart> &
  EvalTurnsOf<TStart>;

/** One turn of a case: the input of the suite's start, checked against it by the suite. */
export const turn = <const TInput>(input: TInput): EvalTurn<TInput> => Object.freeze({ input });

/**
 * One past turn of a case's thread, written and not run: `start` with its `input`, answered by
 * `finish` with its `output` — the thread's memory reads it as `start <name>` / `finish <name>`.
 */
export function pastTurn<TStart extends Class, TFinish extends Class>(
  start: TStart,
  input: ExecutionInputOf<InstanceType<TStart>>,
  finish: TFinish,
  output: OutputOf<InstanceType<TFinish>>,
): EvalPastTurn {
  return Object.freeze({ start, input, finish, output });
}

/** One case of a suite: its name, contexts, history, turns and expectations, as written. */
export const evalCase = <const TCase extends EvalCase>(options: TCase): TCase =>
  Object.freeze(options);
