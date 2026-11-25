import { recordOptionKeys } from "../../components/option-keys.js";
import { EVAL_SUITE_KEYS } from "../../components/decorator-options.js";
import type { Class } from "../../components/injection.js";
import type { EvalAttemptHook } from "./attempts.js";
import type { EvalCase, EvalCaseOf } from "./cases.js";
import { EvalCascade } from "./checks.js";
import type { EvalToolExpectations } from "./tool-expectations.js";

/**
 * `@EvalSuite` (#396, `@agboss/core/eval`): a named set of cases run through one start of an
 * application, judged by its tool expectations and its judges — `eval-suites/<name>.eval-suite.ts`, one class
 * per file, its `name` ending with `-eval-suite`. The decorator only records it: nothing runs at
 * import (the runner is the CLI's, loaded on demand).
 */

/** What every suite declares. */
export interface EvalSuiteOptions<TStart extends Class = Class> {
  /** Kebab-case, ending with `-eval-suite` (`[name.kind-suffix]`): `--suite <name>`. */
  readonly name: string;
  /** What the suite checks, for a reader of the report. */
  readonly description?: string;
  /** The `@WorkflowStart` every turn goes through: a start of the application (`[eval.unknown-start]`). */
  readonly start: TStart;
  /** The `@Judge` classes of every run, after the tools check, in order. */
  readonly judges?: readonly Class<object>[];
  /** Tool expectations of every case, together with each case's own `tools`. */
  readonly tools?: EvalToolExpectations;
  /**
   * The model provider the suite's model judges (and a comparison's pairwise arbiter) run on: a
   * `@ModelProvider` class, pinned and isolated from the candidate's — a judge's own
   * `modelProvider` wins, else this, else the application's (`[eval.judge-missing-provider]` when
   * none of the three is set for a model judge).
   */
  readonly modelProvider?: Class;
  /** Before every run of every case, ahead of the case's own `beforeAttempt`. */
  readonly beforeAttempt?: EvalAttemptHook;
  /** After every run of every case, after the case's own `afterAttempt`, whether the run passed or not. */
  readonly afterAttempt?: EvalAttemptHook;
  /** What a failed check does to the ones after it; default `EvalCascade.StopAtFirstFailure`. */
  readonly cascade?: EvalCascade;
  /** The cases, each name unique (`[eval.duplicate-case]`); their turns typed by `start`'s input. */
  readonly cases: readonly EvalCaseOf<InstanceType<TStart>>[];
}

/** A suite as recorded: its options with the cases as written. */
export interface EvalSuiteMeta extends Omit<EvalSuiteOptions, "cases" | "cascade" | "judges"> {
  readonly cascade: EvalCascade;
  readonly judges: readonly Class<object>[];
  readonly cases: readonly EvalCase[];
}

const suites = new WeakMap<Class, EvalSuiteMeta>();

/** The `@EvalSuite` options of a class; `undefined` when it is not a suite. */
export const evalSuiteOf = (cls: Class): EvalSuiteMeta | undefined => suites.get(cls);

/** Declares an eval suite: its start, judges, tools, cascade and cases (`agboss eval run --suite <name>`). */
export function EvalSuite<const TStart extends Class>(
  options: EvalSuiteOptions<TStart>,
): <C extends Class>(value: C) => C {
  return (value) => {
    recordOptionKeys(value, "EvalSuite", options, EVAL_SUITE_KEYS);
    const cases: readonly EvalCase[] = options.cases;
    const cascade = options.cascade ?? EvalCascade.StopAtFirstFailure;
    const judges = Object.freeze([...(options.judges ?? [])]);
    suites.set(value, Object.freeze({ ...options, cascade, judges, cases: Object.freeze(cases) }));
    return value;
  };
}
