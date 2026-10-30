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
  type OutboundCallEventRecord,
  type LeaseEventStep,
  type LeaseTakeoverRecord,
  type StepHandedOverRecord,
} from "../infrastructure/execution-lease-event.repository.js";
export {
  ChildExecutionQueueRepository,
  type ChildExecutionEnd,
  type QueuedChildExecution,
} from "../infrastructure/child-execution-queue.repository.js";
export { SqliteConnection } from "../infrastructure/sqlite/sqlite-connection.js";
export { SqliteCheckpointSaver } from "../infrastructure/sqlite/sqlite-checkpoint-saver.js";
export { SqliteCostLedgerRepository } from "../infrastructure/sqlite/sqlite-cost-ledger.repository.js";
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
// the fenced effect (#500): the contract, its key and outcome, the in-memory store, its settings
export {
  fencedEffectKeyOf,
  FencedEffectRepository,
  FencedEffectStatus,
  type FencedEffectKey,
  type FencedEffectOutcome,
  type FencedEffectWork,
  type JsonPrimitive,
  type JsonResult,
} from "../infrastructure/fenced-effect.repository.js";
export {
  InMemoryFencedEffectRepository,
  InMemoryFencedEffectTransaction,
} from "../infrastructure/in-memory-fenced-effect.repository.js";
export {
  FencedEffectSettings,
  type FencedEffectsOptions,
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
export type { Milliseconds, Usd } from "../units/index.js";
// calls that leave the system (#505): the store's contract, its in-memory default, the service,
// its verdicts and outcome, its settings
export {
  OutboundCallRepository,
  OutboundCallStatus,
  type OutboundCallClaim,
  type OutboundCallFailure,
  type OutboundCallIntent,
  type OutboundCallRecord,
  type OutboundCallState,
  type OutboundCallStep,
} from "../infrastructure/outbound-call.repository.js";
export { InMemoryOutboundCallRepository } from "../infrastructure/outbound-call.repository.js";
export {
  OutboundCallOutcomeStatus,
  OutboundCallPart,
  OutboundCallReconciliation,
  OutboundCalls,
  OutboundCallVerdict,
  type OutboundCall,
  type OutboundCallLookup,
  type OutboundCallOptions,
  type OutboundCallOutcome,
  type OutboundCallUnknownOptions,
} from "../app/outbound-calls.js";
export {
  OutboundCallSettings,
  type OutboundCallsOptions,
} from "../infrastructure/fenced-effect-settings.js";
