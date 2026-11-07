/**
 * `@agboss/core/testing/faults` (#484): the fault suite, for any store set. `faultSuite({ name,
 * storesModule, database })` runs the fixture application in several real `node` processes on one
 * database, injects real faults — SIGTERM, SIGKILL, SIGSTOP / SIGCONT, a database cut by a TCP
 * proxy — and checks after each scenario that every tree had one owner at a time, every child and
 * every charge happened once, no hand-over undid anything and every tree finished; its sabotages
 * prove it bites on the set (#831). The store hold points (`withHoldPoints`, `StoreHoldPoint`,
 * `processHoldPoints`) force the order of operations across processes, and
 * `reportHeldOperations` tells a store's own process tests what its held stores do.
 *
 * The pods, the cluster, the gateway, the proxy and the scenarios' code are the suite's own, not
 * published (#831). Not re-exported by `@agboss/core` or `@agboss/core/testing`: it imports vitest.
 */
export {
  FaultStoreTime,
  type FaultBusinessRows,
  type FaultEnvironment,
  type FaultStoreSet,
} from "./fault-stores.js";
export {
  HoldPhase,
  HoldPoints,
  processHoldPoints,
  StoreAnswerLostError,
  type HeldOperation,
  type HoldRequest,
} from "./hold-points.js";
export {
  reportHeldOperations,
  withHoldPoints,
  type HeldOperationsReport,
} from "./held-stores.js";
export { StoreHoldPoint } from "./store-points.js";
export { OperationPhase, type OperationEvent } from "./operation-history.js";
export { faultSuite, type FaultShard, type FaultSuiteOptions } from "./fault-suite.js";
export type { FaultScenario, FaultScenarioOptions } from "./scenario.js";
export type { FaultDatabase } from "./cluster-options.js";
export { FAULT_SABOTAGE_SCENARIOS, FAULT_SCENARIOS } from "./scenarios/index.js";
export {
  FaultInvariant,
  FaultInvariantError,
  type FaultViolation,
} from "./invariants/violations.js";
