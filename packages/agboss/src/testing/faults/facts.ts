import type { ExecutionHistoryRecord } from "../../infrastructure/execution-history.repository.js";
import type { ExecutionLeaseEventRecord } from "../../infrastructure/execution-lease-event.repository.js";
import type { OutboundCallRecord } from "../../infrastructure/outbound-call.repository.js";
import type { OperationHistory } from "./operation-history.js";
import type { PodEvent } from "./pod-protocol.js";

/**
 * What the invariants of a fault run are checked on (#484): read only through the public API, by
 * a live pod at the end of the run — every root execution's kept record (`ExecutionHistoryRecord`:
 * its status, finish, output, children and undo actions), every tree's lease log
 * (`app.leaseEventsOf`) and calls that left the system (`app.outboundCallsOf`), the business rows
 * committed — and, kept by the test, the gateway's payments and requests, every pod's events and
 * the history of every store operation.
 */

/** One tree's lease log and outbound calls. */
export interface FaultTreeFacts {
  readonly rootExecutionId: string;
  readonly leaseEvents: readonly ExecutionLeaseEventRecord[];
  readonly outboundCalls: readonly OutboundCallRecord[];
}

/** What a pod reads at the end of a run. */
export interface FaultFacts {
  readonly records: readonly ExecutionHistoryRecord[];
  readonly trees: readonly FaultTreeFacts[];
  readonly businessRows: readonly string[];
}

/** One request that reached the test's gateway. */
export interface GatewayRequest {
  readonly pod: string;
  readonly idempotencyKey: string;
  readonly orderId: string;
}

/** One payment the gateway made. */
export interface GatewayPaymentFact {
  readonly paymentId: string;
  readonly idempotencyKey: string;
}

/** An event of a pod, with the pod's name. */
export type PodEventFact = PodEvent & { readonly pod: string };

/** Everything a scenario's invariants read. */
export interface FaultRun extends FaultFacts {
  /** The orders the test started, by the order's id, and whether each must finish. */
  readonly orders: readonly { readonly orderId: string; readonly decline: boolean }[];
  readonly requests: readonly GatewayRequest[];
  readonly payments: readonly GatewayPaymentFact[];
  readonly events: readonly PodEventFact[];
  readonly history: OperationHistory;
  /** How much faster than real time the pods' clocks ran (#533: the checker maps the history's times by it). */
  readonly timeScale?: number;
}
