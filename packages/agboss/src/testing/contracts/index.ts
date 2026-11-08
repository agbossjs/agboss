/**
 * `@agboss/core/testing/contracts` (#481): the core's store contract suites, published — a store
 * that lives outside the core (PostgreSQL, Redis, …) runs them in its own vitest suite and proves
 * it behaves as the built-in in-memory and SQLite stores, which run the very same suites:
 *
 * `executionLeaseContract({ name: "PostgreSQL", instance: (context) => new PgLeases(pool, context.clock, context.application), reset: truncate })`
 *
 * `storeConformance({ name, stores: { executionLease, fencedEffect, … } })` (#526) runs every
 * contract a store set claims in one call and refuses a set that leaves a fencing contract out.
 *
 * `ragConnectorContract({ name, connector, documents })` (#700) is a knowledge base connector's:
 * tenant isolation, re-indexing that replaces, `topK`, the signal, the cost.
 *
 * One function per contract; each registers `describe("<contract> contract (<name>)")` with the
 * contract's rules as cases, every case on two instances over one backing store and the suite's
 * `VirtualClock`. Not re-exported by `@agboss/core/testing`: it imports vitest's `describe` / `it`.
 */
export type {
  ContractCaseBody,
  ContractInstances,
  ContractTarget,
  StoreInstanceContext,
} from "./instance-context.js";
export { checkpointSaverContract } from "./checkpoint-saver.contract.js";
export { childExecutionQueueContract } from "./child-execution-queue.contract.js";
export { costLedgerContract } from "./cost-ledger.contract.js";
export { executionHistoryContract } from "./execution-history.contract.js";
export { executionLeaseContract } from "./execution-lease.contract.js";
export { executionLeaseEventContract } from "./execution-lease-event.contract.js";
export { executionRecordContract } from "./execution-record.contract.js";
export {
  fencedEffectContract,
  type FencedEffectBusinessRows,
  type FencedEffectTarget,
} from "./fenced-effect.contract.js";
export { executionTreeContract } from "./execution-tree.contract.js";
export { meshRequestContract } from "./mesh-request.contract.js";
export { a2aTaskContract } from "./a2a-task.contract.js";
export { outboundCallContract, type OutboundCallTarget } from "./outbound-call.contract.js";
export { effectKeyForTesting } from "./effect-key.js";
export { pausedExecutionContract } from "./paused-execution.contract.js";
export { rateLimitContract } from "./rate-limit.contract.js";
export {
  storeConformance,
  type StoreEntry,
  type StoreSet,
  type StoreConformanceOptions,
} from "./store-conformance.js";
export { StoreConformanceError, type LeftOutContract } from "./store-conformance-check.js";
export type { FencingContractOptions } from "./fencing-gate.js";
export type { InterleavingOptions } from "./explorer/register.js";
export { ragConnectorContract } from "./rag-connector.contract.js";
export { StoreCapability } from "./store-capability.js";
export {
  runConformanceSabotage,
  type ConformanceSabotageOptions,
  type SabotageCase,
  type SabotageRun,
} from "./sabotage-run.js";
export { VirtualClock, type VirtualClockOptions } from "../clock.js";
export type { RagConnectorContractTarget, RagContractDocument } from "./rag-connector-data.js";
