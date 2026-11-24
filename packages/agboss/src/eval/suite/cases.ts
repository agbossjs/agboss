import type { Class } from "../../components/injection.js";
import type { ExecutionInputOf, ExecutionOptionsOf, OutputOf } from "../../flow/generated-types.js";
import type { ExecutionStatus } from "../../app/types.js";
import type { EvalAttemptHook } from "./attempts.js";
import type { EvalPauseScript } from "./pauses.js";
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
  /** The pauses this turn meets, answered in this order (`answerPause`, `replyToPause`). */
  readonly pauses?: readonly EvalPauseScript[];
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
  /**
   * The turns run on the thread, in order; at least one. The checks judge the last. Or, for one
   * turn, `input` (and its `pauses`) instead.
   */
  readonly turns?: readonly EvalTurn[];
  /** A single turn's input: the shorthand of `turns: [turn(input, { pauses })]`. */
  readonly input?: unknown;
  /** The pauses of the single turn `input`; a multi-turn case puts them in `turn(input, { pauses })`. */
  readonly pauses?: readonly EvalPauseScript[];
  /** How the last turn must end; default `ExecutionStatus.Finished`. A mismatch fails the run. */
  readonly expectedStatus?: ExecutionStatus;
  /** What the run's tool calls must and must not be, checked before the judges. */
  readonly tools?: EvalToolExpectations;
  /** `@Judge` classes of this case only, after the suite's. */
  readonly judges?: readonly Class<object>[];
  /** Rewordings of the last turn (`--metamorphic`): the same tools, the same key arguments. */
  readonly variants?: readonly EvalTurn[];
  /** Before each run of this case (after the suite's `beforeAttempt`): reset what the run reads. */
  readonly beforeAttempt?: EvalAttemptHook;
  /** After each run of this case, passed or not (before the suite's `afterAttempt`). */
  readonly afterAttempt?: EvalAttemptHook;
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
export type EvalTurnsOf<TStart> =
  | {
      readonly turns: readonly EvalTurn<EvalValueOf<ExecutionInputOf<TStart>>>[];
      readonly input?: never;
      readonly pauses?: never;
      readonly variants?: readonly EvalTurn<EvalValueOf<ExecutionInputOf<TStart>>>[];
    }
  | {
      readonly input: EvalValueOf<ExecutionInputOf<TStart>>;
      readonly pauses?: readonly EvalPauseScript[];
      readonly turns?: never;
      readonly variants?: readonly EvalTurn<EvalValueOf<ExecutionInputOf<TStart>>>[];
    };

/** `tenant` / `execution` of a case for a start: required where its application declares them. */
export type EvalContextsOf<TStart> = {
  readonly [TKey in keyof Pick<ExecutionOptionsOf<TStart>, "tenant" | "execution">]: EvalValueOf<
    ExecutionOptionsOf<TStart>[TKey]
  >;
};

/**
 * A case as a suite of `TStart` (an instance of its start) takes it: its turns are the start's
 * input, `tenant` / `execution` its application's context values — required where the application
 * declares its own context classes, as at `app.execute`.
 */
export type EvalCaseOf<TStart> = Omit<
  EvalCase,
  "tenant" | "execution" | "turns" | "input" | "pauses" | "variants"
> &
  EvalContextsOf<TStart> &
  EvalTurnsOf<TStart>;

/** One turn of a case: the input of the suite's start, checked against it by the suite. */
export const turn = <const TInput>(
  input: TInput,
  options: { readonly pauses?: readonly EvalPauseScript[] } = {},
): EvalTurn<TInput> => Object.freeze({ input, ...options });

/** The turns a case runs: its own, or the one turn its `input` and `pauses` say. */
export function turnsOfCase(written: EvalCase): readonly EvalTurn[] {
  if (written.turns !== undefined) return written.turns;
  if (!("input" in written)) return [];
  return [
    { input: written.input, ...(written.pauses === undefined ? {} : { pauses: written.pauses }) },
  ];
}

/** What `pastTurn` takes (#1328): the start and its input, the finish and its output. */
export interface PastTurnOptions<TStart extends Class, TFinish extends Class> {
  readonly start: TStart;
  readonly input: ExecutionInputOf<InstanceType<TStart>>;
  readonly finish: TFinish;
  readonly output: OutputOf<InstanceType<TFinish>>;
}

/**
 * One past turn of a case's thread, written and not run: `pastTurn({ start, input, finish, output })` —
 * `start` with its `input`, answered by `finish` with its `output`; the thread's memory reads it as
 * `start <name>` / `finish <name>`.
 */
export function pastTurn<TStart extends Class, TFinish extends Class>(
  options: PastTurnOptions<TStart, TFinish>,
): EvalPastTurn {
  const { start, input, finish, output } = options;
  return Object.freeze({ start, input, finish, output });
}

/** One case of a suite: its name, contexts, history, turns and expectations, as written. */
export const evalCase = <const TCase extends EvalCase>(options: TCase): TCase =>
  Object.freeze(options);
