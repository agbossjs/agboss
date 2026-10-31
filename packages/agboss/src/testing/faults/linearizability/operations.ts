import type { HistoryOperation, OperationHistory } from "../operation-history.js";
import { StoreHoldPoint } from "../store-points.js";

/**
 * The operations a linearizability check reads (#533 item 5): each store operation of a fault
 * run's history as its span on the store's time — from its invoke to its complete, mapped from the
 * machine's monotonic clock by the run's time scale — what it asked and what the store answered.
 * One that never completed, or failed with anything but the fence's refusal (a store outage), has
 * an unknown answer: it may have taken effect or not.
 */

/** An answer nobody saw. */
export const UNKNOWN = Symbol("unknown");

/** One operation, ready for the model. */
export interface CheckedOperation {
  readonly id: string;
  readonly kind: StoreHoldPoint;
  /** The application instance that made it: a lease's holder. */
  readonly holder: string;
  readonly input: Readonly<Record<string, unknown>>;
  /** What the store answered (`"fenced"` for the fence's refusal), or `UNKNOWN`. */
  readonly output: unknown;
  /**
   * Its span on the machine's time, as store ms: invoked, completed (`+∞` when it never did). The
   * real-time order: one completed before another was invoked took effect first. Every pod reads
   * one clock (the host's monotonic), so this order is exact.
   */
  readonly invokedAt: number;
  readonly completedAt: number;
  /** The span widened by the slack: the store's own instant it took effect at is within. */
  readonly from: number;
  readonly to: number;
}

/** The operations of the fencing stores the model knows. */
const MODELLED: ReadonlySet<string> = new Set([
  StoreHoldPoint.LeaseAcquire,
  StoreHoldPoint.LeaseRenew,
  StoreHoldPoint.LeaseRelease,
  StoreHoldPoint.LeaseFinish,
  StoreHoldPoint.LeaseYield,
  StoreHoldPoint.LeaseReclaim,
  StoreHoldPoint.FencedEffectWrite,
  StoreHoldPoint.OutboundFindByKey,
  StoreHoldPoint.OutboundSaveIfAbsent,
  StoreHoldPoint.OutboundMarkPending,
  StoreHoldPoint.OutboundMarkCompleted,
  StoreHoldPoint.OutboundMarkFailed,
  StoreHoldPoint.OutboundLeaseStateOf,
]);

/** A monotonic time (ns, as text) on the store's time (ms): `scale` times faster than real. */
const storeMsOf = (at: string, scale: number): number =>
  (Number(BigInt(at) / 1000n) / 1000) * scale;

/** What the store answered: its output, the fence's refusal, or unknown. */
function outputOf({ complete }: HistoryOperation): unknown {
  if (complete === undefined) return UNKNOWN;
  if (complete.error === undefined) return complete.output ?? null;
  return complete.error.name === "ExecutionFencedError" ? "fenced" : UNKNOWN;
}

/**
 * The modelled operations of `history`, in the order invoked; `scale` maps the machine's time to
 * the store's, and `slack` (store ms) widens each span for the two clocks' reading jitter.
 */
export function checkedOperationsOf(
  history: OperationHistory,
  scale: number,
  slack: number,
): CheckedOperation[] {
  return history.operations
    .filter((operation) => MODELLED.has(operation.invoke.operation))
    .map((operation) => {
      const { invoke, complete } = operation;
      const invokedAt = storeMsOf(invoke.at, scale);
      const completedAt =
        complete === undefined ? Number.POSITIVE_INFINITY : storeMsOf(complete.at, scale);
      return {
        id: invoke.id,
        kind: invoke.operation,
        holder: invoke.instanceId,
        input: (invoke.input ?? {}) as Readonly<Record<string, unknown>>,
        output: outputOf(operation),
        invokedAt,
        completedAt,
        from: invokedAt - slack,
        to: completedAt + slack,
      };
    });
}

/** A text field of a recorded input; `""` when it is not one. */
export const textOf = (input: Readonly<Record<string, unknown>>, name: string): string => {
  const value = input[name];
  return typeof value === "string" ? value : "";
};

/** A number field of a recorded input; `undefined` when it is not one. */
export const numberOf = (
  input: Readonly<Record<string, unknown>>,
  name: string,
): number | undefined => {
  const value = input[name];
  return typeof value === "number" ? value : undefined;
};
