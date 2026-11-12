/**
 * The ready SQLite implementations of the infrastructure contracts (#265), each enabled only by
 * listing it in `@Application({ providers })`, and the queue of children on any instance
 * (#333 PR 2), and the audit log (#501). `node:sqlite` is loaded only when a connection opens.
 */
export {
  ExecutionAuditEventKind,
  ExecutionAuditLogRepository,
  FencedEffectEventOutcome,
  HandOverReason,
  HandOverSite,
  LeaseTakeoverReason,
  type ExecutionAuditEventBase,
  type ExecutionAuditEventRecord,
  type FencedEffectRecord,
  OutboundCallEventOutcome,
  type OutboundCallEventRecord,
  type OutboundCallClosedLease,
  type AuditEventStep,
  type LeaseTakeoverRecord,
  type StepHandedOverRecord,
} from "../infrastructure/execution-audit-log.repository.js";
export {
  ChildExecutionQueueRepository,
  type ChildExecutionEnd,
  type ChildExecutionQueueCounts,
  type ChildExecutionQueueWatch,
  type QueuedChildExecution,
} from "../infrastructure/child-execution-queue.repository.js";
export { SqliteConnection } from "../infrastructure/sqlite/sqlite-connection.js";
export { SqliteCheckpointSaver } from "../infrastructure/sqlite/sqlite-checkpoint-saver.js";
export { SqliteCostLedgerRepository } from "../infrastructure/sqlite/sqlite-cost-ledger.repository.js";
export type { LedgerKey } from "../finops/ledger-mark.js";
// the store helpers of the ledger (#817, #869) are in `@agboss/core/stores` (#890)
export { SqliteExecutionLeaseRepository } from "../infrastructure/sqlite/sqlite-execution-lease.repository.js";
export { SqliteExecutionRecordRepository } from "../infrastructure/sqlite/sqlite-execution-record.repository.js";
// what the SQLite records and the built-in default extend (#906 D5): a records store over a `TurnStore`
export { TurnStoreRecordRepository } from "../infrastructure/execution-record.repository.js";
export { SqliteExecutionAuditLogRepository } from "../infrastructure/sqlite/sqlite-execution-lease.repository.js";
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
// the fenced effect (#500): the service an app injects (#890), the contract, its key and outcome,
// the in-memory store, its settings
export { FencedEffects } from "../app/fenced-effects.js";
export {
  effectKeyOf,
  FencedEffectRepository,
  FencedEffectStatus,
  FingerprintNotJsonError,
  FingerprintPolicy,
  FingerprintRequiredError,
  IdempotencyKeyMissingError,
  type IdempotencyKeyMissingErrorOptions,
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
// what a business key's missing fingerprint decision is (#825); the store helpers of a key (#526
// AC5) are in `@agboss/core/stores` (#890)
export {
  FingerprintProblem,
  type FingerprintRequiredErrorOptions,
} from "../infrastructure/fenced-effect-key.js";
export { InMemoryFencedEffectRepository } from "../infrastructure/in-memory-fenced-effect.repository.js";
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
  NewTurn,
  Summary,
  Turn,
  TurnOutcome,
  TurnRecords,
  TurnStatus,
  TurnStep,
  VersionScore,
} from "../turns/index.js";
// the names before #890, deprecated: removed in 0.2 (by `export *`, so no module of the core names them)
export type * from "./turn-deprecated.js";
export {
  CostCategory,
  CostSource,
  type CostLine,
  type CostReport,
  type TokenUsage,
} from "../finops/usage.js";
// a usage record's one ledger state (#817) and what a ledger saves
export {
  LedgerState,
  ledgerMarkOf,
  type LedgerMark,
  type RecordedElsewhereLedgerMark,
  type WrittenLedgerMark,
} from "../finops/ledger-mark.js";
export type { LedgerEntry } from "../infrastructure/cost-ledger.repository.js";
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
// (the rows only its store reads — claim, state, lease, … — are in `@agboss/core/stores`, #890; an
// intent and its step are what a record an application reads is made of)
export {
  OutboundCallRepository,
  OutboundCallStatus,
  type OutboundCallFailure,
  type OutboundCallIntent,
  type OutboundCallPage,
  type OutboundCallRecord,
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
// #807: the A2A tasks an application serves (infrastructure, listed in `@Application({ providers })`)
export {
  A2ATaskRepository,
  A2ATaskSaveStatus,
  A2ATaskState,
  InvalidA2APageTokenError,
  type InvalidA2APageTokenErrorOptions,
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
// #860: the direct A2A messages' replies (infrastructure, listed in `@Application({ providers })`)
export * from "../infrastructure/a2a-direct-message.repository.js";
export { InMemoryA2ADirectMessageRepository } from "../infrastructure/in-memory-a2a-direct-message.repository.js";
// #859: the A2A tasks' files (infrastructure, listed in `@Application({ providers })`)
export {
  A2AFileConflictError,
  type A2AFileConflictErrorOptions,
  A2AFileRepository,
  type A2AFileKey,
  type A2AFileMetadata,
  type A2AFileOwner,
  type NewA2AFile,
} from "../infrastructure/a2a-file.repository.js";
export type { A2AFileOptions } from "../a2a/files/a2a-file-options.js";
export type { RetentionOptions } from "../application/retention.js";
