/**
 * The errors a run can fail with — every one a `AGBossError` with a stable `code`, so a flow
 * can `.onError(<class>, …)` it (also after a resume from a checkpoint) and a caller can tell them
 * apart. `limit` ⊃ `limit.budget`, `limit.steps`, `limit.visits`, `limit.depth` (#264), `limit.mesh-loop`, `limit.hops` (#398); `step` ⊃ `step.failed` (`StepFailedError`, #273 S22) ⊃
 * `step.agent`, `step.action`, `step.guard`, `step.router`, `step.arbiter`, `step.quorum` (#279),
 * `step.child` (`ChildExecutionFailedError`, #263) and `step.tool-blocked` (`ToolBlockedError`, #384);
 * `step.pause-expired` (`PauseExpiredError`, #941) is a pause whose deadline passed, `pause.expiry-handler-failed` (`PauseError.ExpiryHandlerFailed`) why its expiry decision fell back to failing;
 * `pause.closed` (`PauseError.Closed`, #939) is a late answer to a closed pause, with its reason.
 */
export {
  AGBossError,
  KeyTextRule,
  keyTextRuleOf,
  type ErrorDetails,
  type AGBossErrorOptions,
  type MessageErrorOptions,
  type PlainErrorOptions,
} from "./core/errors.js";
export { errorRecordOf, type ErrorRecord } from "./core/error-record.js";
// diagnostics and backtraces (#1325c)
export { BacktraceMode } from "./core/diagnostics/backtrace.js";
export type { ErrorDiagnostics, ErrorFormatOptions } from "./core/diagnostics/error-report.js";
export type { ExecutionSpanFrame } from "./core/diagnostics/span-trace.js";
export type { LabeledSpan, SourceSpan } from "./core/diagnostics/source-span.js";
export { type RuleCode, type RuleViolation } from "./graph/rule-error.js";
export {
  BudgetExceededError,
  type BudgetExceededErrorOptions,
  LimitExceededError,
  type LimitExceededErrorOptions,
  StepsLimitExceededError,
  type StepsLimitExceededErrorOptions,
  type BudgetBreach,
} from "./graph/limits.js";
export {
  AgentFailedError,
  type AgentFailedErrorOptions,
  GuardFailedError,
  type GuardFailedErrorOptions,
  PaidStepError,
  type PaidStepErrorOptions,
  QualityGateError,
  type QualityGateErrorOptions,
  StepFailedError,
  type StepFailedErrorOptions,
  type JudgeRejection,
  type StepCoordinates,
} from "./graph/errors.js";
export {
  RouterDecisionError,
  type RouterDecisionErrorOptions,
  RouterFailedError,
  type RouterFailedErrorOptions,
  type RouterVisit,
} from "./flow/runtime/router-error.js";
export {
  ActionFailedError,
  type ActionFailedErrorOptions,
  QuestionFailedError,
  type QuestionFailedErrorOptions,
  AgentAnswerInvalidError,
  type AgentAnswerInvalidErrorOptions,
  GuardrailBlockedError,
  type GuardrailBlockedErrorOptions,
  VisitsLimitExceededError,
  type VisitsLimitExceededErrorOptions,
} from "./flow/runtime/errors.js";
export {
  ArbiterError,
  type ArbiterErrorOptions,
  QuorumNotReachedError,
  type QuorumNotReachedErrorOptions,
  type QuorumShortfall,
} from "./flow/runtime/launch/quorum-errors.js";
export { ToolBlockedError, type ToolBlockedErrorOptions } from "./graph/tool-blocked-error.js";
export { PiiRefusedError, type PiiRefusedErrorOptions } from "./pii/errors.js";
export { PiiDetectionFailedError } from "./pii/detectors/model.js";
export {
  ChildExecutionFailedError,
  type ChildExecutionFailedErrorOptions,
} from "./flow/runtime/child-errors.js";
export {
  DepthLimitExceededError,
  type DepthLimitExceededErrorOptions,
} from "./flow/runtime/depth-limit.js";
export {
  DeadlineExceededError,
  type DeadlineExceededErrorOptions,
  type ExecutionDeadline,
} from "./budgets/execution-deadline.js";
export {
  HopsLimitExceededError,
  type HopsLimitExceededErrorOptions,
  MeshLoopDetectedError,
  type MeshLoopDetectedErrorOptions,
  type MeshLimitPlace,
} from "./mesh/mesh-errors.js";
export { ExecutionContextUnavailableError } from "./flow/context/errors.js";
export { SpendOutsideStepError } from "./components/spend-recorder.js";
export {
  ModelCallError,
  type ModelCallErrorOptions,
  type ModelCallErrorCode,
} from "./models/circuit-breaker.js";
export { ToolTimeoutError, type ToolTimeoutErrorOptions } from "./tools/index.js";
export { type EvalCaseIssue } from "./eval/suite/errors.js";
export * from "./flow/runtime/pause-expired-error.js";
export { NotPausedError } from "./run/resume-agent.js";
export { ModelKind } from "./llm/decision-errors.js";
export { ApplicationStoppingError } from "./core/errors.js";
export { cancelFencedErrorOf } from "./app/handed-over.js";
export {
  fencedRefusalOf,
  ExecutionLeaseLostError,
  type ExecutionLeaseLostErrorOptions,
  type FencedWriteRefusal,
} from "./app/lease-lost.js";
