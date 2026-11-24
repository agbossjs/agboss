/**
 * The ready SQLite implementations of the infrastructure contracts (#265), each enabled only by
 * listing it in `@Application({ providers })`, and the queue of children on any instance
 * (#333 PR 2), and the audit log (#501). `node:sqlite` is loaded only when a connection opens.
 */
export {
  ExecutionAuditEventKind,
  ExecutionAuditLogRepository,
  IdempotencyRunEventOutcome,
  HandOverReason,
  HandOverSite,
  LeaseTakeoverReason,
  type ExecutionAuditEventBase,
  type ExecutionAuditEventRecord,
  type IdempotencyRunRecord,
  OutboundCallEventOutcome,
  type OutboundCallEventRecord,
  type OutboundCallClosedLease,
  type AuditEventStep,
  type LeaseTakeoverRecord,
  type StepHandedOverRecord,
  type EndedTree,
} from "../infrastructure/execution-audit-log.repository.js";
export type {
  ExecutionHistoryQuery,
  TenantExecutionHistoryQuery,
} from "../infrastructure/execution-history.repository.js";
// the status history of a thread (#1341d): `app.getStatusHistory`
export {
  StatusTrigger,
  ThreadStatus,
  type NewStatusTransition,
  type StatusContext,
  type ThreadStatusTransition,
} from "../turns/index.js";
export type { ExecutionRecordStatusQuery } from "../infrastructure/execution-record.repository.js";
export {
  ChildExecutionQueueRepository,
  type ChildExecutionEnd,
  type ChildExecutionQueueCounts,
  type ChildExecutionQueueWatch,
  type QueuedChildExecution,
} from "../infrastructure/child-execution-queue.repository.js";
export { SqliteCheckpointSaver } from "../infrastructure/sqlite/sqlite-checkpoint-saver.js";
export { SqliteCostLedgerRepository } from "../infrastructure/sqlite/sqlite-cost-ledger.repository.js";
export type { LedgerKey } from "../finops/ledger-mark.js";
// the store helpers of the ledger (#817, #869) are in `@agboss/core/stores` (#890)
export { SqliteExecutionLeaseRepository } from "../infrastructure/sqlite/sqlite-execution-lease.repository.js";
export { SqliteExecutionRecordRepository } from "../infrastructure/sqlite/sqlite-execution-record.repository.js";
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
// the idempotent effect (#500, #1317): the service an app injects, the store's contract, its outcome
// and the in-memory store (the key and its helpers are in `@agboss/core/stores`)
export { Idempotency } from "../app/idempotency.js";
export type { IdempotencyKeyChoice, IdempotencyRunOptions } from "../app/idempotency-types.js";
export {
  FencedEffectRepository,
  IdempotencyRunStatus,
  type FencedEffectOrigin,
  type IdempotencyRunOutcome,
  type FencedEffectWork,
  type JsonPrimitive,
  type JsonValue,
} from "../infrastructure/fenced-effect.repository.js";
export { InMemoryFencedEffectRepository } from "../infrastructure/in-memory-fenced-effect.repository.js";
// every type an infrastructure contract's members name (#511 AC4, tests/public-api/contract-types):
// a store outside the core implements the contract with these, never derives them from the class
export type {
  ConfigSnapshot,
  NewSummary,
  NewTurn,
  Summary,
  Turn,
  TurnOutcome,
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
export { InMemoryOutboundCallRepository } from "../infrastructure/in-memory-outbound-call.repository.js";
export {
  OutboundCallSendStatus,
  type OutboundCall,
  type OutboundCallLookup,
  type IdempotencySendOptions,
  type OutboundCallOutcome,
} from "../app/idempotency.js";
export type { OutboundCallPart } from "../app/outbound-call-errors.js";
export {
  OutboundRecovery,
  Reconciliation,
  ReconciliationVerdict,
  type CompletedReconciliation,
  type LookupRecovery,
  type NotExecutedReconciliation,
  type ReplayRecovery,
  type UnknownReconciliation,
} from "../app/outbound-recovery.js";
// #859, #1316: the files a step keeps and reads (infrastructure, listed in `@Application({ providers })`)
export {
  FileRepository,
  type FileKey,
  type FileMetadata,
  type FileOwner,
  type FileOrphanSweep,
  type FileOwnerCompletion,
  type FileSweep,
  type NewFile,
} from "../infrastructure/file.repository.js";
export type { RetentionOptions } from "../application/retention.js";

// budgets limit dollars and tokens (#1318)
export { BudgetUnit, type DeclaredLimits } from "../budgets/budget.js";
export type { BudgetLimit, BudgetUsage } from "../infrastructure/cost-ledger.repository.js";
