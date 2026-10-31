import type { HistoryOperation, OperationHistory } from "../operation-history.js";
import { StoreHoldPoint } from "../store-points.js";

/**
 * What the history of store operations says (#484): the leases granted — by `acquire` and
 * `reclaim`, each epoch of each key with its holder and when the store answered —, the leases
 * finished, and the fenced writes the store accepted, each with its token and its time span.
 */

/** A lease the store granted. */
export interface Grant {
  readonly key: string;
  readonly epoch: number;
  readonly holder: string;
  /** When the store answered (the complete's monotonic time). */
  readonly at: string;
  readonly by: string;
}

/** A fenced write the store accepted. */
export interface AcceptedWrite {
  readonly operation: string;
  /** The lease's execution: the key of its grants. */
  readonly key: string;
  readonly token: number;
  readonly instanceId: string;
  /** When it was asked, and when the store answered. */
  readonly invokedAt: string;
  readonly completedAt: string;
  readonly id: string;
}

/** The lease operations that grant one. */
const GRANTS: ReadonlySet<string> = new Set([
  StoreHoldPoint.LeaseAcquire,
  StoreHoldPoint.LeaseReclaim,
]);

/** The fenced writes, and whether an answer is an acceptance. */
const WRITES: ReadonlyMap<string, (output: unknown) => boolean> = new Map([
  [
    StoreHoldPoint.FencedEffectWrite,
    (output: unknown) => (output as { status?: string } | null)?.status === "ran",
  ],
  [StoreHoldPoint.OutboundSaveIfAbsent, (output: unknown) => output === true],
  [StoreHoldPoint.OutboundMarkPending, (output: unknown) => output === true],
  [StoreHoldPoint.OutboundMarkCompleted, (output: unknown) => output === true],
  [StoreHoldPoint.OutboundMarkFailed, (output: unknown) => output === true],
]);

/** The completed operations of `history`. */
const completed = (history: OperationHistory): readonly Required<HistoryOperation>[] =>
  history.operations.filter(
    (operation): operation is Required<HistoryOperation> =>
      operation.complete !== undefined && operation.complete.error === undefined,
  );

/** Every lease granted, in the order the store answered. */
export function grantsOf(history: OperationHistory): readonly Grant[] {
  return completed(history)
    .filter(({ invoke, complete }) => GRANTS.has(invoke.operation) && complete.output !== null)
    .map(({ complete }) => {
      const lease = complete.output as {
        rootExecutionId: string;
        leaseEpoch: number;
        holderInstanceId: string;
      };
      return {
        key: lease.rootExecutionId,
        epoch: lease.leaseEpoch,
        holder: lease.holderInstanceId,
        at: complete.at,
        by: complete.id,
      };
    })
    .sort((left, right) => (BigInt(left.at) < BigInt(right.at) ? -1 : 1));
}

/** When each lease key was first finished (`lease.finish` answered). */
export function finishesOf(history: OperationHistory): ReadonlyMap<string, string> {
  const finished = new Map<string, string>();
  for (const { invoke, complete } of completed(history)) {
    if (invoke.operation !== StoreHoldPoint.LeaseFinish) continue;
    if (invoke.key === undefined) continue;
    if (!finished.has(invoke.key)) finished.set(invoke.key, complete.at);
  }
  return finished;
}

/** Every fenced write the store accepted. */
export function acceptedWritesOf(history: OperationHistory): readonly AcceptedWrite[] {
  return completed(history).flatMap(({ invoke, complete }) => {
    const accepts = WRITES.get(invoke.operation);
    if (!(accepts?.(complete.output) ?? false)) return [];
    const { leaseExecutionId, token } = invoke.input as { leaseExecutionId: string; token: number };
    return [
      {
        operation: invoke.operation,
        key: leaseExecutionId,
        token,
        instanceId: invoke.instanceId,
        invokedAt: invoke.at,
        completedAt: complete.at,
        id: invoke.id,
      },
    ];
  });
}
