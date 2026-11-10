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

/**
 * A fenced write the store was asked (#876: answered or not). One the store's lease check let
 * through (#840) is an `AcceptedWrite`: any answer but an error — a write that ran, and one that
 * found its key already there (`replayed`, `false`), since every fenced write checks the lease
 * first and a refused one throws `ExecutionFencedError`.
 */
export interface FencedWrite {
  readonly operation: string;
  /** The lease's execution: the key of its grants. */
  readonly key: string;
  readonly token: number;
  readonly instanceId: string;
  /** Which fenced write of the key it is (#876: what the store's rows name it by). */
  readonly scopeKey: string;
  readonly idempotencyKey: string;
  readonly name: string;
  /** An outbound call's write: the attempt's owner it writes (#876: what its row names it by). */
  readonly attemptOwner?: string;
  /** When it was asked. */
  readonly invokedAt: string;
  readonly id: string;
}

/** A fenced write the store answered: when it did. */
export interface AcceptedWrite extends FencedWrite {
  readonly completedAt: string;
}

/** The lease operations that grant one. */
const GRANTS: ReadonlySet<string> = new Set([
  StoreHoldPoint.LeaseAcquire,
  StoreHoldPoint.LeaseReclaim,
]);

/**
 * The fenced writes (#840: whatever they answer — the lease check came first, and a refusal is an
 * error, never an answer).
 */
const WRITES: ReadonlySet<string> = new Set([
  StoreHoldPoint.FencedEffectWrite,
  StoreHoldPoint.OutboundSaveIfAbsent,
  StoreHoldPoint.OutboundMarkPending,
  StoreHoldPoint.OutboundMarkCompleted,
  StoreHoldPoint.OutboundMarkFailed,
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
        token: number;
        holderInstanceId: string;
      };
      return {
        key: lease.rootExecutionId,
        epoch: lease.token,
        holder: lease.holderInstanceId,
        at: complete.at,
        by: complete.id,
      };
    })
    .sort((left, right) => (BigInt(left.at) < BigInt(right.at) ? -1 : 1));
}

/** When each lease key was first retired (`lease.retire` answered). */
export function finishesOf(history: OperationHistory): ReadonlyMap<string, string> {
  const finished = new Map<string, string>();
  for (const { invoke, complete } of completed(history)) {
    if (invoke.operation !== StoreHoldPoint.LeaseRetire) continue;
    if (invoke.key === undefined) continue;
    if (!finished.has(invoke.key)) finished.set(invoke.key, complete.at);
  }
  return finished;
}

/** What a fenced write's invoke says of it. */
function fencedWriteOf(invoke: HistoryOperation["invoke"]): FencedWrite {
  const { leaseExecutionId, token, scopeKey, idempotencyKey, name, attemptOwner, claim } =
    invoke.input as {
      leaseExecutionId: string;
      token: number;
      scopeKey: string;
      idempotencyKey: string;
      name: string;
      attemptOwner?: string;
      claim?: { attemptOwner?: string };
    };
  const owner = attemptOwner ?? claim?.attemptOwner;
  return {
    operation: invoke.operation,
    key: leaseExecutionId,
    token,
    instanceId: invoke.instanceId,
    scopeKey,
    idempotencyKey,
    name,
    ...(owner === undefined ? {} : { attemptOwner: owner }),
    invokedAt: invoke.at,
    id: invoke.id,
  };
}

/** Every fenced write the store's lease check let through: answered, not refused. */
export function acceptedWritesOf(history: OperationHistory): readonly AcceptedWrite[] {
  return completed(history)
    .filter(({ invoke }) => WRITES.has(invoke.operation))
    .map(({ invoke, complete }) => ({ ...fencedWriteOf(invoke), completedAt: complete.at }));
}

/**
 * Every fenced write the store was asked and never answered (#876): its pod died between the
 * write and the record. Whether it was let through only the store's rows tell.
 */
export function unansweredWritesOf(history: OperationHistory): readonly FencedWrite[] {
  return history.operations
    .filter(({ invoke, complete }) => complete === undefined && WRITES.has(invoke.operation))
    .map(({ invoke }) => fencedWriteOf(invoke));
}

/** How many times each child's queue row was completed (`childQueue.complete` answered `true`). */
export function childCompletionsOf(history: OperationHistory): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const { invoke, complete } of completed(history)) {
    if (invoke.operation !== StoreHoldPoint.ChildComplete || complete.output !== true) continue;
    const key = invoke.key ?? "";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
