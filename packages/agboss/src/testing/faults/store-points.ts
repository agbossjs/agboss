import type { ExecutionLease } from "../../infrastructure/execution-lease.repository.js";
import type { FencedEffectKey } from "../../infrastructure/fenced-effect.repository.js";
import type { QueuedChildExecution } from "../../infrastructure/child-execution-queue.repository.js";
import type { ExecutionHistoryRecord } from "../../infrastructure/execution-history.repository.js";

/**
 * The store hold points (#484 AC5): the operations of the fencing stores — the lease, the fenced
 * effect, the outbound call — and of the child queue that a test may hold in a process and records
 * in the history. Each names the store method it wraps, how its key, what it was asked and what it
 * answered are read (identities and tokens only, never a payload).
 */

/** A store operation a test may hold. */
export enum StoreHoldPoint {
  LeaseAcquire = "lease.acquire",
  LeaseRenew = "lease.renew",
  LeaseRelease = "lease.release",
  LeaseFinish = "lease.finish",
  LeaseYield = "lease.yield",
  LeaseReclaim = "lease.reclaim",
  /** The fenced effect's transaction: the lease check, the mark, the key, the business write. */
  FencedEffectWrite = "fencedEffect.write",
  OutboundFindByKey = "outboundCall.findByKey",
  OutboundSaveIfAbsent = "outboundCall.saveIfAbsent",
  OutboundMarkPending = "outboundCall.markPending",
  OutboundMarkCompleted = "outboundCall.markCompleted",
  OutboundMarkFailed = "outboundCall.markFailed",
  OutboundLeaseStateOf = "outboundCall.leaseStateOf",
  ChildClaim = "childQueue.claim",
  ChildComplete = "childQueue.complete",
  /** A root's kept record saved (#401): what the invariants read once its tree ended. */
  HistorySave = "executionHistory.save",
}

/** How one wrapped method is read. */
export interface StoreMethod {
  readonly point: StoreHoldPoint;
  /** The key a hold matches before the store is asked (`undefined`: known only from the answer). */
  readonly keyOf: (args: readonly unknown[]) => string | undefined;
  readonly inputOf: (args: readonly unknown[]) => unknown;
  readonly outputOf: (result: unknown) => unknown;
  /** The key once answered (a claim's child); default: the key before. */
  readonly resultKeyOf?: (result: unknown) => string | undefined;
}

/** What the history keeps of a lease. */
export const leaseFacts = (lease: unknown): unknown => {
  if (lease === undefined || lease === null) return null;
  const { tenantId, rootExecutionId, holderInstanceId, leaseEpoch, expiresAt, takenOverFrom } =
    lease as ExecutionLease;
  return {
    tenantId,
    rootExecutionId,
    holderInstanceId,
    leaseEpoch,
    expiresAt: expiresAt.toISOString(),
    // the time the store said is left (#533)
    remaining: (lease as ExecutionLease).remaining,
    ...(takenOverFrom === undefined ? {} : { takenOverFrom }),
  };
};

/** What the history keeps of a fenced key. */
export const keyFacts = (key: unknown): unknown => {
  const { scopeKey, tenantId, leaseExecutionId, token, idempotencyKey, name, businessKey } =
    key as FencedEffectKey;
  const business = businessKey === undefined ? {} : { businessKey };
  return { scopeKey, tenantId, leaseExecutionId, token, idempotencyKey, name, ...business };
};

const first = (args: readonly unknown[]): unknown => args[0];
const asIs = (result: unknown): unknown => (result === undefined ? null : result);
const rootOf = (args: readonly unknown[]): string => (args[0] as ExecutionLease).rootExecutionId;
const leaseKeyOf = (args: readonly unknown[]): string =>
  (args[0] as FencedEffectKey).leaseExecutionId;

/** A method on a held lease: its key and input are the lease's. */
const onLease = (point: StoreHoldPoint, outputOf = asIs): StoreMethod => ({
  point,
  keyOf: rootOf,
  inputOf: (args) => leaseFacts(first(args)),
  outputOf,
});

/** A fenced method of the outbound-call store: its key is the fenced key's. */
const onKey = (point: StoreHoldPoint, outputOf = asIs): StoreMethod => ({
  point,
  keyOf: leaseKeyOf,
  inputOf: (args) => keyFacts(first(args)),
  outputOf,
});

/** The lease store's methods. */
export const LEASE_METHODS: Readonly<Record<string, StoreMethod>> = {
  acquire: {
    point: StoreHoldPoint.LeaseAcquire,
    keyOf: (args) => String(args[1]),
    inputOf: (args) => ({ tenantId: args[0], rootExecutionId: args[1] }),
    outputOf: leaseFacts,
  },
  renew: onLease(StoreHoldPoint.LeaseRenew),
  release: onLease(StoreHoldPoint.LeaseRelease),
  finish: onLease(StoreHoldPoint.LeaseFinish),
  yield: onLease(StoreHoldPoint.LeaseYield),
  reclaim: onLease(StoreHoldPoint.LeaseReclaim, leaseFacts),
};

/** The fenced-effect store's transaction (`runInTransaction`, what every write goes through). */
export const FENCED_EFFECT_METHODS: Readonly<Record<string, StoreMethod>> = {
  runInTransaction: onKey(StoreHoldPoint.FencedEffectWrite, (result) => {
    const { status, token } = result as { readonly status: string; readonly token: number };
    return { status, token };
  }),
};

/** The outbound-call store's fenced methods. */
export const OUTBOUND_CALL_METHODS: Readonly<Record<string, StoreMethod>> = {
  findByKey: onKey(StoreHoldPoint.OutboundFindByKey, (record) => {
    if (record === undefined) return null;
    const { status, attempt, token } = record as Record<string, unknown>;
    return { status, attempt, token };
  }),
  saveIfAbsent: onKey(StoreHoldPoint.OutboundSaveIfAbsent),
  markPending: onKey(StoreHoldPoint.OutboundMarkPending),
  markCompleted: onKey(StoreHoldPoint.OutboundMarkCompleted),
  markFailed: onKey(StoreHoldPoint.OutboundMarkFailed),
  leaseStateOf: {
    point: StoreHoldPoint.OutboundLeaseStateOf,
    keyOf: (args) => (args[0] as { readonly leaseExecutionId: string }).leaseExecutionId,
    inputOf: first,
    outputOf: asIs,
  },
};

/** What the history keeps of a claimed child. */
const childFacts = (child: unknown): unknown => {
  if (child === undefined) return null;
  const { tenantId, executionId, rootExecutionId } = child as QueuedChildExecution;
  return { tenantId, executionId, rootExecutionId };
};

/** The child queue's claim and completion. */
export const CHILD_QUEUE_METHODS: Readonly<Record<string, StoreMethod>> = {
  claimFirstByStatusQueuedOrderByDepthDesc: {
    point: StoreHoldPoint.ChildClaim,
    keyOf: () => undefined,
    inputOf: () => ({}),
    outputOf: childFacts,
    resultKeyOf: (child) => (child as QueuedChildExecution | undefined)?.executionId,
  },
  completeByTenantIdAndExecutionId: {
    point: StoreHoldPoint.ChildComplete,
    keyOf: (args) => String(args[1]),
    inputOf: (args) => ({ tenantId: args[0], executionId: args[1] }),
    outputOf: asIs,
  },
};

/** The history store's save: the record of a root, by its execution. */
export const HISTORY_METHODS: Readonly<Record<string, StoreMethod>> = {
  save: {
    point: StoreHoldPoint.HistorySave,
    keyOf: (args) => (args[0] as ExecutionHistoryRecord).executionId,
    inputOf: (args) => ({ status: (args[0] as ExecutionHistoryRecord).status }),
    outputOf: asIs,
  },
};
