import type { EvalCase } from "../suite/cases.js";
import type { EvalAttempt, EvalAttemptHook } from "../suite/attempts.js";
import type { EvalRunError } from "./report.js";
import type { SuiteRunParts } from "./case-run.js";

/**
 * The hooks around one run of a case (#1328d): the suite's `beforeAttempt` then the case's, the
 * case's `afterAttempt` then the suite's — each phase stopping at the first that throws.
 */

/**
 * What a hook of an attempt threw, as the run's error: the error's class only — a hook reads stubs
 * and databases, and what it throws may carry their rows into a report that is shared.
 */
const hookErrorOf = (phase: "beforeAttempt" | "afterAttempt", error: unknown): EvalRunError => ({
  code: "eval.attempt-hook-failed",
  message: `${phase} threw ${error instanceof Error ? error.name : typeof error}`,
});

/** The hooks of an attempt in the order they run: the suite's first before, last after. */
export const hooksOf = (
  parts: SuiteRunParts,
  written: EvalCase,
  phase: "beforeAttempt" | "afterAttempt",
): readonly (EvalAttemptHook | undefined)[] =>
  phase === "beforeAttempt"
    ? [parts.suite.beforeAttempt, written.beforeAttempt]
    : [written.afterAttempt, parts.suite.afterAttempt];

/** Runs the hooks in order; the first that throws stops the rest and is the error. */
export async function runHooks(
  hooks: readonly (EvalAttemptHook | undefined)[],
  attempt: EvalAttempt,
  phase: "beforeAttempt" | "afterAttempt",
): Promise<EvalRunError | undefined> {
  for (const hook of hooks) {
    try {
      await hook?.(attempt);
    } catch (error) {
      return hookErrorOf(phase, error);
    }
  }
  return undefined;
}
