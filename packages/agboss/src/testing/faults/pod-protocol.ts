import type { HeldOperation, HoldRequest } from "./hold-points.js";
import type { OperationEvent } from "./operation-history.js";
import type { FaultRunOrder } from "./facts.js";
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
  /** One order that rests at a question its thread owner answers (#959): `resume` continues it. */
  Pause = "pause",
  /** The paused order whose question expires (#941): nobody answers in 30 s, the channel approves it. */
  Expiring = "expiring",
}

/**
 * How the fixture's payment talks to the gateway (#657, #658): its `reconcile`, what it says of an
 * error, and how far it trusts a `notSent()` (#795) — the default and one each scenario needs, with the
 * sabotages that prove the scenarios bite.
 */
export enum FaultPayment {
  /** A lookup by the order's reference (it never expires); every error of unknown outcome. */
  Lookup = "lookup",
  /** A gateway with no lookup: `reconcile` replays the key, the gateway's retention declared. */
  ReplayOnly = "replay-only",
  /** The sabotage of `ReplayOnly`: the same replay, trusted as a lookup (`NotSentTrust.Lookup`, #795). */
  ReplayOnlyTrustedAsLookup = "replay-only-trusted-as-lookup",
  /** The sabotage of `Lookup`: every error the gateway answers taken for a definite failure. */
  EveryErrorDefinite = "every-error-definite",
  /**
   * The sabotage of #928 (S2a): a payment whose record of the answer was never answered by the
   * store — an outcome unknown — is taken for one that was not sent: sent again, never reconciled.
   */
  UnknownAsNotSent = "unknown-as-not-sent",
}

/**
 * What the test's gateway answers a charge it refuses (#928 s21e): a definite failure — it carried
 * nothing out — that the fixture's default payment recognizes by this text.
 */
export const REFUSED_ANSWER =
  "the gateway refused the charge (422 Unprocessable): nothing was charged";

/** A store sabotage a pod can be started with (#959 AC5): its fenced-effect store broken on purpose. */
export enum FaultStoreSabotage {
  /** A stale token let through at the lease's current epoch, the pod killed before the answer (#876). */
  StaleThenKilled = "stale-then-killed",
  /** A lease store whose finish (`retire`) is a plain `release`: finished work can be granted again (#520, #971). */
  RetireReleases = "retire-releases",
  /**
   * A fenced-effect store that answers `Ran` for a write that does not answer in time (#928 S2b):
   * an unknown outcome taken for done, under the framework's own bound.
   */
  TimeoutAsRan = "timeout-as-ran",
  /**
   * A fenced-effect store that reads a transport error after the send as a definite failure (#1017
   * S3): the classifier off, so an applied charge whose answer was reset fails the step.
   */
  ResetAsDefinite = "reset-as-definite",
}

/** An order of the fixture application. */
export interface FaultOrder {
  readonly orderId: string;
  /** The charge declines for real: the tree fails and its reservation is undone. */
  readonly decline?: boolean;
  /**
   * The tree fails for real at its payment (#657, #658: an error of unknown outcome, a refused
   * resend) — its reservation undone once; another start of the order may still pay it.
   */
  readonly fails?: boolean;
  /** The test cancels it (#941): it ends cancelled, never finished — no end is expected of it. */
  readonly cancelled?: boolean;
  /** How its payment talks to the gateway (default `Lookup`). */
  readonly payment?: FaultPayment;
}

/** A start of `order` as the run's facts keep it (#657, #658: whether it fails for real). */
export const runOrderOf = (order: FaultOrder): FaultRunOrder => ({
  orderId: order.orderId,
  decline: order.decline ?? false,
  fails: order.fails ?? false,
});

/** What a test asks of a pod. */
export type PodCommand =
  | { readonly op: "arm"; readonly request: HoldRequest }
  | { readonly op: "disarm"; readonly armId: string }
  | { readonly op: "release"; readonly holdId: string }
  | { readonly op: "release-all" }
  /** Stops the pod itself (SIGSTOP) between two turns of its event loop, once the reply is sent. */
  | { readonly op: "freeze" }
  | {
      readonly op: "start";
      readonly tag: string;
      readonly workflow: FaultWorkflow;
      readonly orders: readonly FaultOrder[];
    }
  | { readonly op: "read"; readonly rootExecutionIds: readonly string[] }
  | { readonly op: "close"; readonly timeout?: number }
  | { readonly op: "outage"; readonly mode: StoreOutageMode | null }
  /** #959: answers the pause `pauseId` (approved) with `app.resume`, in the background; its end is an event. */
  | { readonly op: "resume"; readonly tag: string; readonly pauseId: string }
  /** #941: `app.cancel` of the thread, in the background; its end is an event (`cancelled`). */
  | { readonly op: "cancel"; readonly tag: string; readonly threadId: string }
  /** #939: the tree's pauses, its paused run and its answer log, as the pod's stores hold them. */
  | { readonly op: "pause-state"; readonly rootExecutionId: string }
  /** #959: how far the store's time moves while `wait` ms of real time pass. */
  | { readonly op: "probe-store-clock"; readonly wait: number };

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
  /** The pod's store sabotage (`FaultStoreSabotage`), when it has one. */
  sabotage: "AGBOSS_FAULT_SABOTAGE",
  /** `1` when the pod's application lists the expiring order (#941). */
  expiring: "AGBOSS_FAULT_EXPIRING",
  /** `1` when the pod keeps the framework's store-call bound (#928). */
  bounded: "AGBOSS_FAULT_BOUNDED",
} as const;

/** What a pod's `ready` says of A2A (#811 AC4): whether its set keeps A2A tasks, its listener. */
export interface PodA2A {
  readonly keepsA2ATasks: boolean;
  readonly a2aUrl: string | undefined;
}

/** The A2A of a `ready` event, checked — else what is wrong with it: never guessed. */
export function podA2AOf(ready: PodEvent): PodA2A | string {
  const { keepsA2ATasks, a2aUrl } = ready;
  if (typeof keepsA2ATasks !== "boolean" || !(a2aUrl === null || typeof a2aUrl === "string"))
    return `a ready event with keepsA2ATasks ${JSON.stringify(keepsA2ATasks)} and a2aUrl ${JSON.stringify(a2aUrl)} — a boolean, and a URL or null`;
  return { keepsA2ATasks, a2aUrl: a2aUrl ?? undefined };
}

/** The value of `POD_VARIABLES.bounded` for a pod that keeps the store-call bound or not (#928). */
export const boundedValueOf = (isBounded: boolean | undefined): string =>
  isBounded === true ? "1" : "";

/** What the environment says of `hasExpiringOrders` (#941). */
export const expiringValueOf = (hasExpiringOrders: boolean | undefined): string =>
  hasExpiringOrders === true ? "1" : "";
