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
export { SqliteChildExecutionQueueRepository } from "../infrastructure/sqlite/sqlite-child-execution-queue.repository.js";
// the fenced effect (#500): the contract, its key and outcome, the in-memory store, its settings
export {
  fencedEffectKeyOf,
  FencedEffectRepository,
  FencedEffectStatus,
  type FencedEffectKey,
  type FencedEffectOutcome,
  type FencedEffectWork,
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
