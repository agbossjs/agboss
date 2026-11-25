import type { Class } from "../../components/injection.js";
import type { EvalToolExpectations } from "./tool-expectations.js";

/**
 * The checks of an eval suite (#396): what decides whether one run of a case passed, in order — the
 * `tools` expectations first (deterministic, no model, $0), then the `@Judge` classes of the suite
 * and of the case (a code judge or a model judge, on the finish's output). The `cascade` is the
 * author's, stated explicitly.
 */

/** How a suite runs its checks after a failed one (`@EvalSuite({ cascade })`; default `StopAtFirstFailure`). */
export enum EvalCascade {
  /** The first failed check stops the rest: they are reported `CheckStatus.Skipped`. */
  StopAtFirstFailure = "stop-at-first-failure",
  /** Every check runs whatever the ones before it decided. */
  RunAll = "run-all",
}

/** What one check decided on one run; a run passes when every check that ran passed. */
export enum CheckStatus {
  Passed = "passed",
  Failed = "failed",
  /** Not run: an earlier check failed under `EvalCascade.StopAtFirstFailure` (the run fails). */
  Skipped = "skipped",
}

/** The tools check: the case's (and the suite's) `tools` against the run's tool calls. */
export interface ToolsEvalCheck {
  readonly tools: true;
}

/** A `@Judge` on the output of the finish the run ended at. */
export interface JudgeEvalCheck {
  readonly judge: Class<object>;
}

/** One check of a run: the tools expectations, or a judge. */
export type EvalCheck = ToolsEvalCheck | JudgeEvalCheck;

/** Whether a check is a judge. */
export const isJudgeCheck = (check: EvalCheck): check is JudgeEvalCheck => "judge" in check;

/** The expectations a case has: the suite's and its own together; `undefined` when neither says any. */
export function toolsOf(
  suite: EvalToolExpectations | undefined,
  own: EvalToolExpectations | undefined,
): EvalToolExpectations | undefined {
  const parts = [suite, own].filter((found) => found !== undefined);
  const merged = {
    required: parts.flatMap((found) => found.required ?? []),
    forbidden: parts.flatMap((found) => found.forbidden ?? []),
    invariants: parts.flatMap((found) => found.invariants ?? []),
  };
  const isEmpty = merged.required.length + merged.forbidden.length + merged.invariants.length === 0;
  return isEmpty ? undefined : merged;
}

/** The checks one case runs, in order: its tools (when any), the suite's judges, then its own. */
export function checksOf(
  suite: { readonly judges: readonly Class<object>[]; readonly tools?: EvalToolExpectations },
  written: { readonly judges?: readonly Class<object>[]; readonly tools?: EvalToolExpectations },
): readonly EvalCheck[] {
  const tools: readonly EvalCheck[] =
    toolsOf(suite.tools, written.tools) === undefined ? [] : [{ tools: true }];
  const judges = [...suite.judges, ...(written.judges ?? [])].map((judge): EvalCheck => ({
    judge,
  }));
  return [...tools, ...judges];
}
