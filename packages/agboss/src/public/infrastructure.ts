/**
 * The ready SQLite implementations of the infrastructure contracts (#265), each enabled only by
 * listing it in `@Application({ providers })`, and the queue of children on any instance
 * (#333 PR 2), and the lease log (#501). `node:sqlite` is loaded only when a connection opens.
 */
export {
  ExecutionLeaseEventKind,
  ExecutionLeaseEventRepository,
  FencedEffectEventOutcome,
  HandOverReason,
  HandOverSite,
  LeaseTakeoverReason,
  type ExecutionLeaseEventBase,
  type ExecutionLeaseEventRecord,
  type FencedEffectRecord,
  OutboundCallEventOutcome,
  OutboundCallLeaseState,
  type OutboundCallEventRecord,
  type OutboundCallClosedLease,
  type LeaseEventStep,
  type LeaseTakeoverRecord,
  type StepHandedOverRecord,
} from "../infrastructure/execution-lease-event.repository.js";
export {
  ChildExecutionQueueRepository,
  type ChildExecutionEnd,
  type ChildExecutionQueueDepth,
  type ChildExecutionQueueWatch,
  type QueuedChildExecution,
} from "../infrastructure/child-execution-queue.repository.js";
export { SqliteConnection } from "../infrastructure/sqlite/sqlite-connection.js";
export { SqliteCheckpointSaver } from "../infrastructure/sqlite/sqlite-checkpoint-saver.js";
export { SqliteCostLedgerRepository } from "../infrastructure/sqlite/sqlite-cost-ledger.repository.js";
export { newEntriesOf } from "../infrastructure/cost-ledger.repository.js";
export { SqliteExecutionLeaseRepository } from "../infrastructure/sqlite/sqlite-execution-lease.repository.js";
export { SqliteExecutionRecordRepository } from "../infrastructure/sqlite/sqlite-execution-record.repository.js";
export { SqliteExecutionLeaseEventRepository } from "../infrastructure/sqlite/sqlite-execution-lease.repository.js";
export { SqliteExecutionHistoryRepository } from "../infrastructure/sqlite/sqlite-execution-history.repository.js";
export { SqliteExecutionTreeRepository } from "../infrastructure/sqlite/sqlite-execution-tree.repository.js";
export { SqlitePausedExecutionRepository } from "../infrastructure/sqlite/sqlite-paused-execution.repository.js";
export { SqliteRateLimitRepository } from "../infrastructure/sqlite/sqlite-rate-limit.repository.js";
export { SqliteFencedEffectRepository } from "../infrastructure/sqlite/sqlite-fenced-effect.repository.js";
export { SqliteOutboundCallRepository } from "../infrastructure/sqlite/sqlite-outbound-call.repository.js";
export { SqliteChildExecutionQueueRepository } from "../infrastructure/sqlite/sqlite-child-execution-queue.repository.js";
// the Secret fields of an environment contract a key field names (#825)
export type { SecretFieldOf } from "../application/application.js";
// what a store class declares (#526, #825): its backend and how it checks the lease
export type { StoreDescriptor } from "../infrastructure/execution-lease.repository.js";
export type { EffectKeyMark, OutboundCallKeyMark } from "../infrastructure/effect-key.js";
// the fenced effect (#500): the contract, its key and outcome, the in-memory store, its settings
export {
  effectKeyOf,
  FencedEffectRepository,
  FencedEffectStatus,
  FingerprintNotJsonError,
  FingerprintPolicy,
  FingerprintRequiredError,
  IdempotencyKeyMissingError,
  type BusinessKeyOptions,
  type EffectKey,
  type EffectKeyFields,
  type EffectKeyOptions,
  type FingerprintKeys,
  type FingerprintedKeyOptions,
  type OutboundCallKey,
  type OutboundCallKeyOptions,
  type UnfingerprintedKeyOptions,
  type FencedEffectOrigin,
  type FencedEffectOutcome,
  type FencedEffectWork,
  type JsonPrimitive,
  type JsonValue,
} from "../infrastructure/fenced-effect.repository.js";
// the rules of a key a store outside the core keeps with the core's own helpers (#526 AC5): the
// name rule, the business key's text (#538), the replay and conflict rule, where its row is, the
// record of an outbound call's intent
export {
  assertBusinessKey,
  assertEffectName,
  effectKeyIdentityOf,
  fingerprintErrorOf,
  FingerprintProblem,
  isKeyFingerprint,
  type FingerprintRequiredErrorOptions,
  pendingOutboundCallOf,
  replayedFromOf,
  storedKeyFactsOf,
  type StoredKeyFacts,
} from "../infrastructure/fenced-effect-key.js";
export {
  InMemoryFencedEffectRepository,
  InMemoryFencedEffectTransaction,
} from "../infrastructure/in-memory-fenced-effect.repository.js";
export {
  FencedEffectSettings,
  type FencedEffectOptions,
  type FencedEffectSettingsOptions,
} from "../infrastructure/fenced-effect-settings.js";
// every type an infrastructure contract's members name (#511 AC4, tests/public-api/contract-types):
// a store outside the core implements the contract with these, never derives them from the class
export type {
  ConfigSnapshot,
  NewSummary,
  NewTern,
  Summary,
  Tern,
  TernOutcome,
  TernStatus,
  TernStep,
  VersionScore,
} from "../terns/index.js";
export type {
  CostCategory,
  CostLine,
  CostReport,
  CostSource,
  TokenUsage,
} from "../finops/usage.js";
// the sum a ledger adds to its counters (#521): stores outside the core use the core's own
export { totalCost } from "../finops/usage.js";
export type { CompensationEntry, CompensationEntryStatus } from "../flow/compensation.js";
export type { ScopeRecords } from "../flow/runtime/records.js";
export type { WaitingPause } from "../pause/types.js";
export type { Compacted } from "../run/compaction.js";
export type { ExecutionData } from "../run/types.js";
export type { ToolCallApprovalAskDto } from "../dto/standard/framework.js";
export type { Brand } from "../types/brand.js";
// calls that leave the system (#505): the store's contract, its in-memory default, the service,
// its verdicts and outcome, its settings
export {
  OutboundCallRepository,
  OutboundCallStatus,
  type OutboundCallClaim,
  type OutboundCallFailure,
  type OutboundCallIntent,
  type OutboundCallLease,
  type OutboundCallPage,
  type OutboundCallRecord,
  type OutboundCallState,
  type OutboundCallStatusQuery,
  type OutboundCallStep,
} from "../infrastructure/outbound-call.repository.js";
export { InMemoryOutboundCallRepository } from "../infrastructure/outbound-call.repository.js";
export { NotSentTrust } from "../app/outbound-call-contract.js";
export type {
  NotSentByKeyReplay,
  NotSentByLookup,
  OutboundCallNotSent,
} from "../app/outbound-call-types.js";
export {
  OutboundCallSendStatus,
  OutboundCallPart,
  OutboundCallReconciliation,
  OutboundCalls,
  OutboundCallVerdict,
  type CompletedReconciliation,
  type NotSentReconciliation,
  type UnknownReconciliation,
  type OutboundCall,
  type OutboundCallLookup,
  type OutboundCallSendOptions,
  type OutboundCallOutcome,
  type OutboundCallUnknownOptions,
} from "../app/outbound-calls.js";
export {
  OutboundCallSettings,
  type OutboundCallOptions,
  type OutboundCallSettingsOptions,
} from "../infrastructure/fenced-effect-settings.js";
// the class a refusal of minted ids names, for a store of your own (#613)
export { idGeneratorNameOf } from "../infrastructure/clock.js";
// #807: the A2A tasks an application serves (infrastructure, listed in `@Application({ providers })`)
export {
  A2ATaskRepository,
  A2ATaskSaveStatus,
  A2ATaskState,
  InvalidA2APageTokenError,
  isTerminalA2ATaskState,
  type A2AMessageKey,
  type A2AMessageRecord,
  type A2ATaskKey,
  type A2ATaskPage,
  type A2ATaskPause,
  type A2ATaskQuery,
  type A2ATaskRecord,
  type A2ATaskSave,
  type A2ATaskStatus,
  type A2ATerminalTaskState,
  type NewA2ATask,
} from "../infrastructure/a2a-task.repository.js";
export { InMemoryA2ATaskRepository } from "../infrastructure/in-memory-a2a-task.repository.js";
export type { RetentionOptions } from "../application/retention.js";
