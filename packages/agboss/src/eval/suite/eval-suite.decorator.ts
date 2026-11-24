import type { Class } from "../../components/injection.js";
import type { EvalCase, EvalCaseOf } from "./cases.js";
import { EvalCascade, type EvalCheck } from "./checks.js";

/**
 * `@EvalSuite` (#396, `@agboss/core/eval`): a named set of cases run through one start of an
 * application, judged by an ordered list of checks — `eval-suites/<name>.eval-suite.ts`, one class
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
  /** The checks of every run, in order: `checkTrajectory()`, `judgedBy(Judge)`. */
  readonly checks: readonly EvalCheck[];
  /** What a failed check does to the ones after it; default `EvalCascade.StopAtFirstFailure`. */
  readonly cascade?: EvalCascade;
  /** The cases, each name unique (`[eval.duplicate-case]`); their turns typed by `start`'s input. */
  readonly cases: readonly EvalCaseOf<InstanceType<TStart>>[];
}

/** A suite as recorded: its options with the cases as written. */
export interface EvalSuiteMeta extends Omit<EvalSuiteOptions, "cases" | "cascade"> {
  readonly cascade: EvalCascade;
  readonly cases: readonly EvalCase[];
}

const suites = new WeakMap<Class, EvalSuiteMeta>();

/** The `@EvalSuite` options of a class; `undefined` when it is not a suite. */
export const evalSuiteOf = (cls: Class): EvalSuiteMeta | undefined => suites.get(cls);

/** Declares an eval suite: its start, checks, cascade and cases (`agboss eval run --suite <name>`). */
export function EvalSuite<const TStart extends Class>(
  options: EvalSuiteOptions<TStart>,
): <C extends Class>(value: C) => C {
  return (value) => {
    const cases: readonly EvalCase[] = options.cases;
    const cascade = options.cascade ?? EvalCascade.StopAtFirstFailure;
    suites.set(value, Object.freeze({ ...options, cascade, cases: Object.freeze(cases) }));
    return value;
  };
}
