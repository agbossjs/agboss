/**
 * The errors a run can fail with — every one a `AGBossError` with a stable `code`, so a flow
 * can `.onError(<class>, …)` it (also after a resume from a checkpoint) and a caller can tell them
 * apart. `limit` ⊃ `limit.budget`, `limit.steps`, `limit.visits`, `limit.depth` (#264), `limit.mesh-loop`, `limit.hops` (#398); `step` ⊃ `step.failed` (`StepFailedError`, #273 S22) ⊃
 * `step.agent`, `step.action`, `step.guard`, `step.router`, `step.arbiter`, `step.quorum` (#279),
 * `step.child` (`ChildExecutionFailedError`, #263) and `step.tool-blocked` (`ToolBlockedError`, #384);
 * `pause.closed` (`PauseClosedError`, #939) is a late answer to a closed pause, with its reason.
 */
export {
  AGBossError,
  DuplicateExecutionIdError,
  type DuplicateExecutionIdErrorOptions,
  ThreadIdsExhaustedError,
  ExecutionCancelledError,
  type ExecutionCancelledErrorOptions,
  InvalidMintedIdError,
  KeyTextRule,
  keyTextRuleOf,
  type ErrorDetails,
  type AGBossErrorOptions,
  type MessageErrorOptions,
  type PlainErrorOptions,
  type InvalidMintedIdErrorOptions,
  type ThreadIdsExhaustedErrorOptions,
} from "./core/errors.js";
export { errorRecordOf, type ErrorRecord } from "./core/error-record.js";
export {
  GraphRuleError,
  type GraphRuleErrorOptions,
  type RuleCode,
  type RuleViolation,
} from "./graph/rule-error.js";
export { FlowSyntaxError } from "./flow/path-builder.js";
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
  OutputInvalidError,
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
export { NotAWorkflowStartError } from "./flow/runtime/start-input.js";
export { PiiRefusedError, type PiiRefusedErrorOptions } from "./pii/errors.js";
export { CompactionError, type CompactionErrorOptions } from "./compaction/errors.js";
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
export {
  CompensationFailedError,
  type CompensationFailedErrorOptions,
} from "./flow/compensation.js";
export { ExecutionContextUnavailableError } from "./flow/context/errors.js";
export { SpendOutsideStepError } from "./components/spend-recorder.js";
export {
  ModelCallError,
  type ModelCallErrorOptions,
  type ModelCallErrorCode,
} from "./models/circuit-breaker.js";
export { ToolTimeoutError, type ToolTimeoutErrorOptions } from "./tools/index.js";
export { DtoValidationError, type DtoValidationErrorOptions } from "./dto/errors.js";
export {
  EvalCaseInvalidError,
  type EvalCaseInvalidErrorOptions,
  type EvalCaseIssue,
} from "./eval/suite/errors.js";
export { NotPausedError } from "./run/resume-agent.js";
export { PauseClosedError, type PauseClosedErrorOptions } from "./app/pause-closed-error.js";
export { PauseAnswererError, UnknownPauseError } from "./run/resume-agent.js";
export {
  ReplyInterpreterMissingError,
  UninterpretableReplyError,
  type UninterpretableReplyErrorOptions,
} from "./channels/decision.js";
export {
  InvalidThreadIdError,
  type InvalidThreadIdErrorOptions,
  ThreadOwnerError,
  UnknownThreadError,
} from "./core/errors.js";
export {
  DecisionError,
  DecisionRequestError,
  DecisionResponseError,
  ModelKind,
  ModelKindError,
  type ModelKindErrorOptions,
} from "./llm/decision-errors.js";
export { ApplicationStoppingError } from "./core/errors.js";
export {
  SyncWorkRequiredError,
  type SyncWorkRequiredErrorOptions,
} from "./infrastructure/sqlite/sqlite-fenced-effect.repository.js";
export {
  InvalidNotSentTrustError,
  OutboundCallSupersededError,
  type InvalidNotSentTrustErrorOptions,
} from "./app/outbound-call-contract.js";
export type {
  OutboundCallSupersededErrorOptions,
  OutboundCallUnmaskedErrorOptions,
} from "./app/outbound-call-types.js";
export {
  OutboundCallInFlightError,
  OutboundCallPayloadTooLargeError,
  OutboundCallResultNotStoredError,
  OutboundCallUnmaskedError,
  OutboundCallUnreconciledError,
  type OutboundCallInFlightErrorOptions,
  type OutboundCallPayloadTooLargeErrorOptions,
  type OutboundCallResultNotStoredErrorOptions,
  type OutboundCallResultNotStoredReason,
  type OutboundCallUnreconciledErrorOptions,
  type OutboundCallUnreconciledReason,
} from "./app/outbound-calls.js";
export {
  CostLedgerCutoffInvalidError,
  type CostLedgerCutoffInvalidErrorOptions,
  CostLedgerEntryExpiredError,
  CostLedgerEntryInvalidError,
  type CostLedgerEntryExpiredErrorOptions,
  type CostLedgerEntryInvalidErrorOptions,
} from "./finops/ledger-mark.js";
export {
  FencedEffectResultTooLargeError,
  BusinessKeyConflictError,
  InvalidBusinessKeyError,
  InvalidFencedEffectNameError,
  type InvalidFencedEffectNameErrorOptions,
  type FencedEffectResultTooLargeErrorOptions,
  type BusinessKeyConflictErrorOptions,
  type FingerprintNotJsonErrorOptions,
  type InvalidBusinessKeyErrorOptions,
} from "./infrastructure/fenced-effect.repository.js";
export {
  FencedEffectStoreMismatchError,
  type FencedEffectStoreMismatchErrorOptions,
} from "./infrastructure/in-memory-fenced-effect.repository.js";
export {
  ExecutionFencedError,
  ExecutionLeaseLostError,
  type ExecutionLeaseLostErrorOptions,
  type ExecutionFencedErrorOptions,
  type FencedWriteRefusal,
} from "./app/lease-lost.js";
