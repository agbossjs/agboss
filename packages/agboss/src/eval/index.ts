/**
 * `@agboss/core/eval` (#396): eval suites — `@EvalSuite` in `eval-suites/<name>.eval-suite.ts` and the
 * builders of its cases and checks. Decorators and builders only: nothing runs at import; the
 * runner (`agboss eval run --suite <name>`) belongs to the CLI and loads on demand.
 */
export {
  EvalSuite,
  type EvalSuiteMeta,
  type EvalSuiteOptions,
} from "./suite/eval-suite.decorator.js";
export {
  evalCase,
  pastTurn,
  type PastTurnOptions,
  turn,
  type EvalCase,
  type EvalCaseOf,
  type EvalPastTurn,
  type EvalTurn,
  type EvalValueOf,
} from "./suite/cases.js";
export {
  answerPause,
  replyToPause,
  type EvalPauseOptions,
  type EvalPauseScript,
} from "./suite/pauses.js";
export { CheckStatus, EvalCascade } from "./suite/checks.js";
export {
  EVAL_RUN_KIND,
  EVAL_RUN_SCHEMA_VERSION,
  EvalCheckKind,
  type EvalCaseReport,
  type EvalCheckResult,
  type EvalRunComponent,
  type EvalRunError,
  type EvalRunReport,
  type EvalRunResult,
  type EvalRunSchemaVersion,
  type EvalRunSpend,
  type EvalRunSummary,
} from "./run/report.js";
export type { EvalModelUse } from "./run/ran-on.js";
export type {
  EvalCaseExpectation,
  EvalChildTrace,
  EvalCompensationTrace,
  EvalExecutionTrace,
  EvalExpectedToolCallTrace,
  EvalGuardrailDecisionTrace,
  EvalHandledErrorTrace,
  EvalJudgeVerdictTrace,
  EvalModelCallTrace,
  EvalPauseTrace,
  EvalStepTrace,
  EvalTrajectory,
  EvalToolCallTrace,
  EvalTraceError,
} from "./run/trace.js";
export { ChaosFailure, type EvalRunChaos } from "./chaos/chaos-failure.js";
export {
  CaseComparison,
  type EvalCaseComparison,
  type EvalCasePasses,
  type EvalRunComparison,
} from "./run/comparison.js";
export type {
  EvalCalibration,
  EvalConfusionMatrix,
  EvalDisagreement,
  EvalJudgeCalibration,
  EvalLabel,
  EvalMetricGroup,
  EvalMetricValue,
  EvalRaterAgreement,
  EvalScoreCounts,
} from "./calibrate/calibration.js";
export {
  toolCall,
  toolInvariant,
  type EvalToolExpectations,
  type ExpectedToolCall,
  type ToolInputPartialOf,
  type ToolInvariant,
} from "./suite/tool-expectations.js";
/** @beta Type machinery of the eval cases: not a contract, names may change. */
export type * as EvalTypes from "./eval-types.js";
