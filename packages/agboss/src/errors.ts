/**
 * The errors a run can fail with — every one a `AGBossError` with a stable `code`, so a flow
 * can `.onError(<class>, …)` it (also after a resume from a checkpoint) and a caller can tell them
 * apart. `limit` ⊃ `limit.budget`, `limit.steps`, `limit.visits`, `limit.depth` (#264), `limit.mesh-loop`, `limit.hops` (#398); `step` (`StepError`, #273 S22) is the family of
 * `step.agent`, `step.action`, `step.guardrail`, `step.router`, `step.arbiter`, `step.quorum` (#279),
 * `step.child` (`StepError.Child`, #263) and `step.tool-blocked` (`StepError.ToolBlocked`, #384);
 * `step.pause-expired` (`StepError.PauseExpired`, #941) is a pause whose deadline passed, `pause.expiry-handler-failed` (`PauseError.ExpiryHandlerFailed`) why its expiry decision fell back to failing;
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
export { type BudgetBreach } from "./graph/limits.js";
export { type JudgeRejection, type StepCoordinates } from "./graph/step-coordinates.js";
export { type RouterVisit } from "./flow/runtime/router-error.js";
export { type QuorumShortfall } from "./flow/runtime/launch/quorum-errors.js";
export { type ExecutionDeadline } from "./budgets/execution-deadline.js";
export { type MeshLimitPlace } from "./mesh/mesh-errors.js";
export { ExecutionContextUnavailableError } from "./flow/context/errors.js";
export { SpendOutsideStepError } from "./components/spend-recorder.js";
export {
  ModelCallError,
  type ModelCallErrorOptions,
  type ModelCallErrorCode,
} from "./models/circuit-breaker.js";
export { ToolTimeoutError, type ToolTimeoutErrorOptions } from "./tools/index.js";
export { type EvalCaseIssue } from "./eval/suite/errors.js";
export { NotPausedError } from "./run/resume-agent.js";
export { ModelKind } from "./llm/decision-errors.js";
export { ApplicationStoppingError } from "./core/errors.js";
export { cancelFencedErrorOf } from "./app/handed-over.js";
export type { CancelFencedFacts } from "./core/error-families/run-error-facts.js";
export type { DefaultedOptions } from "./core/error-families/family.js";
export type { PauseExpiredFacts, StepDefaulted } from "./core/error-families/step-error-specs.js";
export {
  fencedRefusalOf,
  ExecutionLeaseLostError,
  type ExecutionLeaseLostErrorOptions,
  type FencedWriteRefusal,
} from "./app/lease-lost.js";
