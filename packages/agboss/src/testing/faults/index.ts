/**
 * `@agboss/core/testing/faults` (#484): the fault suite, for any store set. `faultSuite({ name,
 * stores, database })` runs the fixture application in several real `node` processes on one
 * database, injects real faults — SIGTERM, SIGKILL, SIGSTOP / SIGCONT, a database cut by a TCP
 * proxy — and checks after each scenario that every tree had one owner at a time, every child and
 * every charge happened once, no hand-over undid anything and every tree finished. The store hold
 * points (`withHoldPoints`, `StoreHoldPoint`) force the order of operations across processes, and
 * the run's history records every store operation's invoke and complete.
 *
 * Not re-exported by `@agboss/core` or `@agboss/core/testing`: it imports vitest.
 */
export {
  defineFaultStores,
  FAULT_BUSINESS_ROWS,
  type FaultBusinessRows,
  type FaultEnvironment,
  type FaultStores,
} from "./fault-stores.js";
export {
  HoldPhase,
  HoldPoints,
  processHoldPoints,
  type HeldOperation,
  type HoldRequest,
} from "./hold-points.js";
export { heldStoreSeam, withHoldPoints, type HeldStoreSeam } from "./held-stores.js";
export { StoreHoldPoint } from "./store-points.js";
export { StoreOutage, StoreOutageError, StoreOutageMode } from "./store-outage.js";
export {
  OperationHistory,
  OperationPhase,
  type HistoryOperation,
  type OperationEvent,
  type OperationRecorder,
} from "./operation-history.js";
export { DatabaseProxy, ProxyState, type ProxyTarget } from "./database-proxy.js";
export { ScaledClock } from "./fault-clock.js";
export { faultSuite, selectedScenarios, type FaultSuiteOptions } from "./fault-suite.js";
export {
  FaultScenarioFailedError,
  runFaultScenario,
  type FaultScenario,
  type FaultScenarioOptions,
} from "./scenario.js";
export { FAULT_SCENARIOS } from "./scenarios/index.js";
export {
  FaultWorld,
  type FaultDatabase,
  type FaultPodOptions,
  type FaultWorldOptions,
} from "./world.js";
export {
  FaultPod,
  FaultWaitError,
  killPods,
  launchPod,
  type PodExit,
  type PodLaunch,
} from "./pod.js";
export { FaultGateway } from "./fault-gateway.js";
export {
  FaultWorkflow,
  type FaultOrder,
  type GatewayCall,
  type PodCommand,
  type PodEvent,
} from "./pod-protocol.js";
export { FaultStepPoint } from "./fixture/pod-link.js";
export { faultViolationsOf, assertFaultInvariants } from "./invariants/check.js";
export {
  FaultInvariant,
  FaultInvariantError,
  type FaultViolation,
} from "./invariants/violations.js";
export type {
  FaultFacts,
  FaultRun,
  FaultTreeFacts,
  GatewayRequest,
  GatewayPaymentFact,
  PodEventFact,
} from "./facts.js";
