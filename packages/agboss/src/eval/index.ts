/**
 * `agboss/eval` (#396): eval suites — `@EvalSuite` in `eval-suites/<name>.eval-suite.ts` and the
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
  turn,
  type EvalCase,
  type EvalCaseOf,
  type EvalPastTurn,
  type EvalTurn,
  type EvalValueOf,
} from "./suite/cases.js";
export {
  CheckStatus,
  checkTrajectory,
  EvalCascade,
  judgedBy,
  type EvalCheck,
  type JudgeEvalCheck,
  type TrajectoryEvalCheck,
} from "./suite/checks.js";
export {
  EVAL_RUN_KIND,
  EVAL_RUN_SCHEMA_VERSION,
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
  EvalToolCallTrace,
  EvalTraceError,
} from "./run/trace.js";
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
  type ToolArgumentsOf,
  type ToolInvariant,
} from "./suite/tool-expectations.js";
