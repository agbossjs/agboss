import type { HeldOperation, HoldRequest } from "./hold-points.js";
import type { OperationEvent } from "./operation-history.js";
import type { StoreOutageMode } from "./store-outage.js";

/**
 * The control channel between a fault test and its pods (#484): Node's IPC channel of each child
 * process (`process.send`), one JSON message at a time. The test sends commands and gets a reply
 * for each (an ack: the pod did it); the pod sends what happened (events), its store operations
 * (the history) and its calls to the test's payment gateway.
 */

/** Which fixture workflow a `start` runs. */
export enum FaultWorkflow {
  /** One order: reserve (undoable), charge (a fenced business row), pay (a gateway call). */
  Order = "order",
  /** A batch of orders, each a child on any instance. */
  Batch = "batch",
}

/** An order of the fixture application. */
export interface FaultOrder {
  readonly orderId: string;
  /** The charge declines for real: the tree fails and its reservation is undone. */
  readonly decline?: boolean;
}

/** What a test asks of a pod. */
export type PodCommand =
  | { readonly op: "arm"; readonly request: HoldRequest }
  | { readonly op: "disarm"; readonly armId: string }
  | { readonly op: "release"; readonly holdId: string }
  | { readonly op: "release-all" }
  | {
      readonly op: "start";
      readonly tag: string;
      readonly workflow: FaultWorkflow;
      readonly orders: readonly FaultOrder[];
    }
  | { readonly op: "read"; readonly rootExecutionIds: readonly string[] }
  | { readonly op: "close"; readonly timeout?: number }
  | { readonly op: "outage"; readonly mode: StoreOutageMode | null };

/** A message from the test to a pod. */
export type ToPod =
  | { readonly kind: "command"; readonly id: number; readonly command: PodCommand }
  | {
      readonly kind: "gateway-reply";
      readonly id: number;
      readonly result?: unknown;
      readonly error?: string;
    };

/** Something that happened in a pod, as it tells the test. */
export interface PodEvent {
  readonly type: string;
  readonly [field: string]: unknown;
}

/** A call of a pod to the test's payment gateway. */
export interface GatewayCall {
  readonly op: "charge" | "lookup";
  readonly idempotencyKey: string;
  readonly orderId: string;
  readonly amount: number;
}

/** A message from a pod to the test. */
export type FromPod =
  | {
      readonly kind: "reply";
      readonly id: number;
      readonly result?: unknown;
      readonly error?: string;
    }
  | { readonly kind: "event"; readonly event: PodEvent }
  | { readonly kind: "operation"; readonly event: OperationEvent }
  | { readonly kind: "gateway"; readonly id: number; readonly call: GatewayCall };

/** A pod's events about holds: a held operation, as `HoldPoints.onHeld` gives it. */
export type HeldEvent = PodEvent & HeldOperation & { readonly type: "held" };

/** The environment variables a pod reads, set by the suite. */
export const POD_VARIABLES = {
  /** The pod's name: `a`, `b`, … */
  name: "AGBOSS_FAULT_POD",
  /** The store set's module (an absolute path or a file URL). */
  stores: "AGBOSS_FAULT_STORES",
  /** The database's address for this pod (through its proxy when it has one). */
  database: "AGBOSS_FAULT_DATABASE_URL",
  /** `@Application({ shutdownTimeout })` of the pod, in ms of its clock. */
  shutdownTimeout: "AGBOSS_FAULT_SHUTDOWN_TIMEOUT",
  /** `@Application({ maxConcurrentSteps })` of the pod. */
  maxConcurrentSteps: "AGBOSS_FAULT_MAX_CONCURRENT_STEPS",
} as const;
