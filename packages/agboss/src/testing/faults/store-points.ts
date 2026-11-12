import type { ExecutionLease } from "../../infrastructure/execution-lease.repository.js";
import type { EffectKey } from "../../infrastructure/fenced-effect.repository.js";
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
  LeaseRetire = "lease.retire",
  LeaseYield = "lease.yield",
  LeaseReclaim = "lease.reclaim",
  /**
   * A tree's cancel made durable (#909), keyed by the tree's root: the anchor of "no effect after a
   * durable cancel" — an effect whose operation was invoked after this one answered must not run.
   */
  LeaseRequestCancel = "lease.requestCancel",
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
  /** A key of a tree saved (#607: an undo's done mark, `tree-points.ts`), keyed by its family. */
  TreeSaveIfAbsent = "executionTree.saveIfAbsent",
  /** An execution id kept (#591, #811: a starter's reserved A2A task id, or a sweep's fence of it). */
  LeaseClaimExecutionId = "lease.claimExecutionId",
  /** An A2A task accepted with its first message (#811, `a2a-points.ts`), keyed by the task's id. */
  A2ATaskSaveIfAbsent = "a2aTask.saveIfAbsent",
  /** An A2A task's status written by compare-and-set (#811), keyed by the task's id. */
  A2ATaskStatusWrite = "a2aTask.compareAndSetStatus",
  /** A pause answered: its atomic `Pending → Resolved` (#811), keyed by the pause's id. */
  PauseResolve = "pause.resolve",
  /** A pause withdrawn: its atomic `Pending → Cancelled` (#811), keyed by the pause's id. */
  PauseCancel = "pause.cancel",
  /** A pause read by its id (#811: a resume reads it before it marks its root running, #850). */
  PauseFind = "pause.find",
  /**
   * A resolved pause marked `Taken`, keyed by the pause's id (#901): by the pass that took its
   * answer, or by the tree's end for an answer no step took.
   */
  PauseMarkTaken = "pause.markTaken",
  /** A pause's channel asked: `isSent` and its `opened` (and a close's) notices, one transaction (#935). */
  PauseMarkSent = "pause.markSent",
  /** A pause's deadline passed: its atomic expiry, with its notices (#935), keyed by the pause's id. */
  PauseExpire = "pause.expire",
  /** An answered pause closed untaken, with its notice (#935), keyed by the pause's id. */
  PauseCloseUntaken = "pause.closeUntaken",
  /** A pause's deadline moved, with its notice (#935), keyed by the pause's id. */
  PauseExtend = "pause.extend",
  /** A pause's reminder recorded, with its notice (#935), keyed by the pause's id. */
  PauseRemind = "pause.remind",
  /** A notice written once for a pause (#935, `joinFailed`), keyed by the pause's id. */
  PauseNoticeOnce = "pause.noticeOnce",
  /** Mailboxes claimed for delivery (#935); the key is known only from the answer: none. */
  PauseNoticeClaim = "pauseNotice.claim",
  /** A mailbox's head acknowledged (#935), keyed by the mailbox's recipient and pause id. */
  PauseNoticeAck = "pauseNotice.ack",
  /** A thread's paused run removed when it is the run's (#935), keyed by the run id. */
  PausedRunDelete = "pausedRun.delete",
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
  const { tenantId, rootExecutionId, holderInstanceId, token, expiresAt, takenOverFrom } =
    lease as ExecutionLease;
  return {
    tenantId,
    rootExecutionId,
    holderInstanceId,
    token,
    expiresAt: expiresAt.toISOString(),
    // the time the store said is left (#533)
    remaining: (lease as ExecutionLease).remaining,
    ...(takenOverFrom === undefined ? {} : { takenOverFrom }),
  };
};

/** What the history keeps of a fenced key (#909: its tree, and whether it is an undo's). */
export const keyFacts = (key: unknown): unknown => {
  const { scopeKey, tenantId, leaseExecutionId, token, idempotencyKey, name, businessKey } =
    key as EffectKey;
  const { rootExecutionId, isCompensation } = key as EffectKey;
  const business = businessKey === undefined ? {} : { businessKey };
  const tree = {
    rootExecutionId: rootExecutionId ?? leaseExecutionId,
    ...(isCompensation === true ? { isCompensation } : {}),
  };
  return {
    scopeKey,
    tenantId,
    leaseExecutionId,
    token,
    idempotencyKey,
    name,
    ...business,
    ...tree,
  };
};

const first = (args: readonly unknown[]): unknown => args[0];
const asIs = (result: unknown): unknown => (result === undefined ? null : result);
const rootOf = (args: readonly unknown[]): string => (args[0] as ExecutionLease).rootExecutionId;
const leaseKeyOf = (args: readonly unknown[]): string => (args[0] as EffectKey).leaseExecutionId;

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

/** A method on a held lease that asks for a length (`renew`, `reclaim`): its input says it too. */
const withLength = (method: StoreMethod): StoreMethod => ({
  ...method,
  inputOf: (args) => ({ ...(leaseFacts(first(args)) as object), lease: args[1] }),
});

/** A fenced method whose input keeps more of its arguments than the key (#533: the model's). */
const withArguments = (
  method: StoreMethod,
  more: (args: readonly unknown[]) => object,
): StoreMethod => ({
  ...method,
  inputOf: (args) => ({ ...(keyFacts(first(args)) as object), ...more(args) }),
});

/** The lease store's methods. */
export const LEASE_METHODS: Readonly<Record<string, StoreMethod>> = {
  acquire: {
    point: StoreHoldPoint.LeaseAcquire,
    keyOf: (args) => String(args[1]),
    // the lease asked for (#533: the linearizability checker's model needs it)
    inputOf: (args) => ({ tenantId: args[0], rootExecutionId: args[1], lease: args[2] }),
    outputOf: leaseFacts,
  },
  renew: withLength(onLease(StoreHoldPoint.LeaseRenew)),
  release: onLease(StoreHoldPoint.LeaseRelease),
  retire: onLease(StoreHoldPoint.LeaseRetire),
  yield: onLease(StoreHoldPoint.LeaseYield),
  reclaim: withLength(onLease(StoreHoldPoint.LeaseReclaim, leaseFacts)),
  requestCancel: {
    point: StoreHoldPoint.LeaseRequestCancel,
    keyOf: (args) => (args[0] as { readonly rootExecutionId: string }).rootExecutionId,
    inputOf: first,
    outputOf: asIs,
  },
  claimExecutionId: {
    point: StoreHoldPoint.LeaseClaimExecutionId,
    keyOf: (args) => (args[0] as { readonly executionId: string }).executionId,
    inputOf: first,
    outputOf: (kept) => ({ kept }),
  },
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
    const { status, attempt, token, attemptOwner } = record as Record<string, unknown>;
    return { status, attempt, token, attemptOwner };
  }),
  saveIfAbsent: withArguments(onKey(StoreHoldPoint.OutboundSaveIfAbsent), (args) => ({
    attemptOwner: (args[1] as { readonly attemptOwner: string }).attemptOwner,
  })),
  markPending: withArguments(onKey(StoreHoldPoint.OutboundMarkPending), (args) => ({
    expected: args[1],
    claim: args[2],
  })),
  markCompleted: withArguments(onKey(StoreHoldPoint.OutboundMarkCompleted), (args) => ({
    attemptOwner: args[1],
  })),
  markFailed: withArguments(onKey(StoreHoldPoint.OutboundMarkFailed), (args) => ({
    attemptOwner: args[1],
  })),
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
