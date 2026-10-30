/**
 * The errors a run can fail with — every one a `AGBossError` with a stable `code`, so a flow
 * can `.onError(<class>, …)` it (also after a resume from a checkpoint) and a caller can tell them
 * apart. `limit` ⊃ `limit.budget`, `limit.steps`, `limit.visits`, `limit.depth` (#264), `limit.mesh-loop`, `limit.hops` (#398); `step` ⊃ `step.failed` (`StepFailedError`, #273 S22) ⊃
 * `step.agent`, `step.action`, `step.guard`, `step.router`, `step.arbiter`, `step.quorum` (#279),
 * `step.child` (`ChildExecutionFailedError`, #263) and `step.tool-blocked` (`ToolBlockedError`, #384).
 */
export {
  AGBossError,
  ExecutionCancelledError,
  type ErrorDetails,
  type AGBossErrorOptions,
} from "./core/errors.js";
export { errorRecordOf, type ErrorRecord } from "./core/error-record.js";
export { GraphRuleError, type RuleCode, type RuleViolation } from "./graph/rule-error.js";
export { FlowSyntaxError } from "./flow/path-builder.js";
export {
  BudgetExceededError,
  LimitExceededError,
  StepsLimitExceededError,
  type BudgetBreach,
} from "./graph/limits.js";
export {
  AgentFailedError,
  GuardFailedError,
  PaidStepError,
  QualityGateError,
  StepFailedError,
  type JudgeRejection,
  type StepCoordinates,
} from "./graph/errors.js";
export {
  RouterDecisionError,
  RouterFailedError,
  type RouterVisit,
} from "./flow/runtime/router-error.js";
export {
  ActionFailedError,
  AgentAnswerInvalidError,
  GuardrailBlockedError,
  OutputInvalidError,
  VisitsLimitExceededError,
} from "./flow/runtime/errors.js";
export {
  ArbiterError,
  QuorumNotReachedError,
  type QuorumShortfall,
} from "./flow/runtime/launch/quorum-errors.js";
export { ToolBlockedError } from "./graph/tool-blocked-error.js";
export { NotAWorkflowStartError } from "./flow/runtime/start-input.js";
export { PiiRefusedError } from "./pii/errors.js";
export { CompactionError } from "./compaction/errors.js";
export { PiiDetectionFailedError } from "./pii/detectors/model.js";
export { ChildExecutionFailedError } from "./flow/runtime/child-errors.js";
export { DepthLimitExceededError } from "./flow/runtime/depth-limit.js";
export { DeadlineExceededError, type ExecutionDeadline } from "./budgets/execution-deadline.js";
export {
  HopsLimitExceededError,
  MeshLoopDetectedError,
  type MeshLimitPlace,
} from "./mesh/mesh-errors.js";
export { CompensationFailedError } from "./flow/compensation.js";
export { ExecutionContextUnavailableError } from "./flow/context/errors.js";
export { SpendOutsideStepError } from "./components/spend-recorder.js";
export { ModelCallError, type ModelCallErrorCode } from "./models/circuit-breaker.js";
export { ToolTimeoutError } from "./tools/index.js";
export { DtoValidationError } from "./dto/errors.js";
export { EvalCaseInvalidError, type EvalCaseIssue } from "./eval/suite/errors.js";
export { NotPausedError } from "./run/resume-agent.js";
export { PauseAnswererError, UnknownPauseError } from "./app/resume.js";
export {
  ReplyInterpreterMissingError,
  UninterpretableReplyError,
  type UninterpretableReplyErrorOptions,
} from "./channels/channel-role.decorator.js";
export { InvalidThreadIdError, ThreadOwnerError, UnknownThreadError } from "./run/thread.js";
export {
  DecisionError,
  DecisionRequestError,
  DecisionResponseError,
  ModelKind,
  ModelKindError,
} from "./llm/decision-errors.js";
export { ApplicationStoppingError } from "./app/application-stopping.js";
export { FencedEffectAsyncWorkError } from "./infrastructure/sqlite/sqlite-fenced-effect.repository.js";
export {
  FencedEffectResultTooLargeError,
  FencedEffectStoreMismatchError,
  type FencedEffectResultTooLargeErrorOptions,
  type FencedEffectStoreMismatchErrorOptions,
} from "./infrastructure/fenced-effect.repository.js";
export {
  ExecutionFencedError,
  ExecutionLeaseLostError,
  type ExecutionFencedErrorOptions,
} from "./app/lease-lost.js";
