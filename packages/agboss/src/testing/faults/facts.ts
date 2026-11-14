import type { ExecutionHistoryRecord } from "../../infrastructure/execution-history.repository.js";
import type { ExecutionAuditEventRecord } from "../../infrastructure/execution-audit-log.repository.js";
import type { OutboundCallRecord } from "../../infrastructure/outbound-call.repository.js";
import type { OperationHistory } from "./operation-history.js";
import type { PodEvent } from "./pod-protocol.js";

/**
 * What the invariants of a fault run are checked on (#484): read only through the public API, by
 * a live pod at the end of the run — every root execution's kept record (`ExecutionHistoryRecord`:
 * its status, finish, output, children and undo actions), every tree's audit log
 * (`app.auditLogOf`) and calls that left the system (`app.outboundCallsOf`), the business rows
 * committed — and, kept by the test, the gateway's payments and requests, every pod's events and
 * the history of every store operation.
 */

/** One tree's audit log and outbound calls. */
export interface FaultTreeFacts {
  readonly rootExecutionId: string;
  readonly auditLog: readonly ExecutionAuditEventRecord[];
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

/**
 * One start of an order: its id, whether its charge declines, and whether the tree fails for real
 * at its payment (#657, #658) — each a failure whose undo runs once; otherwise it must finish.
 */
export interface FaultRunOrder {
  readonly orderId: string;
  readonly decline: boolean;
  readonly fails: boolean;
}

/** A tree as a scenario sampled it mid-run (#941): its root's status beside its pauses'. */
export interface TreeSample {
  readonly rootExecutionId: string;
  readonly rootStatus: string | null;
  readonly pauseStatuses: readonly string[];
  readonly note: string;
}

/** Everything a scenario's invariants read. */
export interface FaultRun extends FaultFacts {
  /** The orders the test started, by the order's id, and whether each must finish. */
  readonly orders: readonly FaultRunOrder[];
  readonly requests: readonly GatewayRequest[];
  readonly payments: readonly GatewayPaymentFact[];
  readonly events: readonly PodEventFact[];
  readonly history: OperationHistory;
  /** The trees the scenario sampled mid-run (#941). */
  readonly samples?: readonly TreeSample[];
  /**
   * How much faster than real time the store's time ran (#533: the checker maps the history's times
   * by it) — 1 for a set on its database's clock, the pods' `timeScale` on the host's (#799).
   */
  readonly timeScale?: number;
}
