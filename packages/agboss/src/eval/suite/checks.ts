import type { JudgeHandlerClass } from "../../components/judge-decorators.js";

/**
 * The checks of an eval suite (#396): what decides whether one run of a case passed, in the order
 * listed — `checkTrajectory()` (the case's tool expectations, deterministic, no model) and
 * `judgedBy(Judge)` (a `@Judge` on the finish's output: a code judge or a model judge). The order
 * and `cascade` are the author's, stated explicitly.
 */

/** How a suite runs its checks after a failed one (`@EvalSuite({ cascade })`, required). */
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

/** `checkTrajectory()`: each case's `tools` expectations against the run's tool calls. */
export interface TrajectoryEvalCheck {
  readonly trajectory: true;
}

/** `judgedBy(Judge)`: a `@Judge` on the output of the finish the run ended at. */
export interface JudgeEvalCheck {
  readonly judge: JudgeHandlerClass;
}

/** One check of an eval suite: the trajectory, or a judge. */
export type EvalCheck = TrajectoryEvalCheck | JudgeEvalCheck;

/** The trajectory check: every case's `tools` (required, forbidden, invariants) — no model, $0. */
export const checkTrajectory = (): TrajectoryEvalCheck => Object.freeze({ trajectory: true });

/**
 * A judge as a check of a suite (or of one case, `evalCase({ judges })`): it judges the output of
 * the finish the run ended at, so its `reply` is that finish's `output` (`[eval.judge-wrong-reply]`).
 */
export const judgedBy = (judge: JudgeHandlerClass): JudgeEvalCheck => Object.freeze({ judge });

/** Whether a check is a judge. */
export const isJudgeCheck = (check: EvalCheck): check is JudgeEvalCheck => "judge" in check;
