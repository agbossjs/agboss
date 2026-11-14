import { scopeKeyOf } from "./lease-lost.js";
import type * as AuditLog from "./audit-log.js";
import type { ObservabilityMask } from "../pii/observability-mask.js";
import type { FrameworkLog } from "../infrastructure/logger.js";
import type { Infrastructure } from "../infrastructure/contracts.js";
import type { EventMask, ExecutionObserverManager } from "../core/observer-manager.js";
import {
  LeaseTakeoverReason,
  type ExecutionAuditLogRepository,
} from "../infrastructure/execution-audit-log.repository.js";
import type {
  ExecutionLease,
  ExecutionLeaseRepository,
} from "../infrastructure/execution-lease.repository.js";
import { treeKeyOf } from "../infrastructure/in-memory-database.js";
import type { ExecutionTree } from "../infrastructure/execution-tree.repository.js";
import { lazyLoad, type Clock } from "../infrastructure/clock.js";
import { seconds, type Milliseconds } from "../units/index.js";
import type { FrameLease } from "../flow/context/frame.js";
import { HeldLease } from "./held-lease.js";
import { EXECUTION_LEASE, sentAtOf } from "./lease-fence.js";
import { leaseReleases } from "./lease-releases.js";

/** The audit events a held lease records (#501), in `lease-yields.ts` beside its other parts. */
export { AuditLogReports } from "./lease-yields.js";

/**
 * Who moves an execution tree (#265, Q58): `app.execute` / `app.resume` hold the tree's lease
 * while they move it, renew it in the background every third of its length and right before
 * every checkpoint write, and release it when the pass ends (paused, finished or failed). While a
 * parent node awaits remote children in-step (#333 PR 4, S9 Q1), it yields the lease in
 * `ExecutionLeaseRepository` — still its own there, renewed on (#516) — and reclaims it before
 * continuing.
 */

/** How often a call waiting for a tree held elsewhere tries again (a release here wakes it at once). */
const RETRY_EVERY: Milliseconds = seconds(1);

/** A tree's lease while this instance moves the tree. */
export interface HeldExecutionLease extends FrameLease {
  readonly rootExecutionId: string;
  /**
   * Aborted with `ExecutionLeaseLostError` when another instance took the lease, or when it ran
   * out with no renewal the store confirmed.
   */
  readonly signal: AbortSignal;
  /**
   * Renews now (before a checkpoint write); throws `ExecutionLeaseLostError` when lost. A store
   * error while the lease is still valid here resolves (the next renewal tries again).
   */
  renew(): Promise<void>;
  /**
   * Runs `check` after every renewal the store confirmed — the background one, the one before a
   * checkpoint write and `renewNow()` (#360: the holder looks for a cancel request); `check` never
   * throws.
   */
  afterEachRenewal(check: RenewalCheck): void;
  /**
   * Runs `listener` when a fenced write or a call of a step under this lease was refused by its
   * tree's cancel (#909, `cancelFound`): the holder's pass stops as cancelled at once.
   */
  whenCancelFound(listener: () => void): void;
  /**
   * Yields the lease in `ExecutionLeaseRepository` while `wait` awaits remote children (#333 PR 4,
   * S9 Q1) — only while no other step of the tree runs (#471) — and reclaims it, at the next token,
   * before returning so `.join()` and checkpoint writes run under it. Yielded is not released
   * (#516): every instance sees the tree held, the renewals go on, a dead holder's lease expires.
   */
  yieldWhile<T>(wait: () => Promise<T>): Promise<T>;
  /**
   * Stops renewing and gives the lease up (nothing to give when it was lost) — for good with
   * `isRetired` (#520: `ExecutionLeaseRepository.retire`, the work under it is over).
   */
  release(options?: { readonly isRetired?: boolean }): Promise<void>;
}

/** What the holder does after a confirmed renewal of its lease (#360). */
export type RenewalCheck = () => Promise<void>;

/** The leases of one application instance's trees. */
export interface ExecutionLeases {
  /**
   * The tree's lease: at once when free, else once its holder releases it or its lease expires;
   * `signal` (the caller's) ends the wait with its reason.
   */
  hold(tree: ExecutionTree, signal?: AbortSignal, take?: LeaseTake): Promise<HeldExecutionLease>;
  /** The tree's lease when it is free now (recovery, #265 S30); `undefined` while another holds it. */
  tryHold(tree: ExecutionTree, take?: LeaseTake): Promise<HeldExecutionLease | undefined>;
  /**
   * The tree's cancel is durable on the lease store's backend (#909): from now on every fencing
   * store refuses a new effect of the tree, in the transaction that checks the lease. Resolves once
   * written; idempotent; rejects with the store's error, nothing written.
   */
  requestCancel(tree: ExecutionTree): Promise<void>;
}

/** What a holder records its takeovers with: the instance's audit log, absent = none. */
export type LeaseTakeoverLog = Pick<
  LeaseTaking,
  "events" | "stopping" | "safetyMargin" | "heldLeases"
>;

/** Where a held lease counts itself (#485, `agboss.instance.leases.held`): until `until` aborts. */
export interface HeldLeases {
  hold(until: AbortSignal): void;
}

export function executionLeasesOf(
  repository: ExecutionLeaseRepository,
  clock: Clock,
  { events, stopping, safetyMargin, heldLeases = events?.heldLeases }: LeaseTakeoverLog = {},
): ExecutionLeases {
  const taking = { repository, clock, events, stopping, safetyMargin, heldLeases };
  const take = (tree: ExecutionTree, why?: LeaseTake): Promise<HeldExecutionLease | undefined> =>
    takeLease(taking, tree, why);
  return {
    tryHold: take,
    requestCancel: (tree) => repository.requestCancel(tree),
    hold: async (tree, signal, why) => {
      const key = treeKeyOf(tree.tenantId, tree.rootExecutionId);
      for (;;) {
        signal?.throwIfAborted();
        const watch = leaseReleases.watch(key);
        try {
          const held = await take(tree, why);
          if (held !== undefined) return held;
          await watch.wait((waiting) => clock.sleep(RETRY_EVERY, waiting), signal);
        } finally {
          watch.close();
        }
      }
    },
  };
}

/** The tree's lease when the store gives it, renewed and watched in the background until released. */
async function takeLease(
  taking: LeaseTaking,
  tree: ExecutionTree,
  take: LeaseTake | undefined,
): Promise<HeldExecutionLease | undefined> {
  const { repository, clock, events } = taking;
  if (await isOver(take)) return undefined;
  const sentAt = sentAtOf(clock);
  const initial = await repository.acquire(tree.tenantId, tree.rootExecutionId, EXECUTION_LEASE);
  if (initial === undefined) return undefined;
  // the work ended while the store was asked (#520): the lease goes back unused, nothing recorded
  if (await isOver(take)) {
    await repository.release(initial).catch((): undefined => undefined);
    leaseReleases.notify(treeKeyOf(tree.tenantId, tree.rootExecutionId));
    return undefined;
  }
  const held = new HeldLease(taking, tree, initial, { sentAt, take });
  await reportTake(events, initial, take);
  return held;
}

/** Whether the work `take` would move is already over (#520); a read that fails is not. */
const isOver = async (take: LeaseTake | undefined): Promise<boolean> =>
  // Stryker disable next-line ArrowFunction: a failed read's `undefined` is not `true` either, so it is not over as with `false`
  (await take?.isOver?.().catch((): boolean => false)) === true;

/**
 * Which takes of a tree's lease are takeovers, and their record in the audit log (#501); the
 * recording itself (`audit-log.ts`) is not in the root import: an instance starts loading it
 * when it builds its audit log, so a takeover never waits for a module.
 */

/** What an instance records its audit events with. */
export interface AuditLogWriter {
  readonly repository: ExecutionAuditLogRepository;
  /** The application's observers, unmasked: they get the event as `mask` shows it. */
  readonly observer: ExecutionObserverManager;
  /** What an event and its row show (the application's PII observability mask). */
  readonly mask: EventMask;
  readonly log: FrameworkLog;
  readonly clock: Clock;
  /** The recording (`audit-log.ts`), loading since the instance was built. */
  readonly recording: Promise<typeof AuditLog>;
  /** The instance's count of the leases it holds (#485); absent = not counted. */
  readonly heldLeases?: HeldLeases | undefined;
}

/** What an instance's audit log is made of besides its infrastructure. */
export interface AuditLogParts {
  readonly observer: ExecutionObserverManager;
  /** The application's PII observability mask. */
  readonly mask: ObservabilityMask;
  readonly log: FrameworkLog;
  /** The instance's count of held leases (#485). */
  readonly heldLeases?: HeldLeases | undefined;
}

/** The instance's audit log: its store and clock, its observers, the application's mask. */
export const auditLogWriterOf = (
  infrastructure: Pick<Infrastructure, "auditLog" | "clock">,
  { observer, mask, log, heldLeases }: AuditLogParts,
): AuditLogWriter => ({
  heldLeases,
  repository: infrastructure.auditLog,
  observer,
  mask: (event) => mask.value(event),
  log,
  clock: infrastructure.clock,
  recording: lazyLoad(import("./audit-log.js")),
});

/**
 * Why a site takes a tree's lease, for the audit log (#501): a take is reported as a takeover when
 * the store names the holder whose lease expired (`takenOverFrom`), and at every take of a site
 * that continues a tree another pass was moving (`isTakeover`: the recovery sweep, a remote child's
 * reclaim, its holder's after a yield) — there `previousHolder…` only when the store names it.
 */
export interface LeaseTake {
  readonly reason: LeaseTakeoverReason;
  readonly isTakeover?: boolean;
  /** The tree's root when the lease is a remote child's own; default the lease's execution. */
  readonly rootExecutionId?: string;
  /** The tree's head checkpoint, read only when the take is reported. */
  readonly checkpointIdOf?: () => Promise<string | undefined>;
  /**
   * Whether the work the lease would move is already over (#520) — a child's queue row no longer
   * the claim taken over, a root's record no longer running: asked before the store and again once
   * it gave the lease. Over → no lease asked for, or the one given released at once, and no
   * takeover recorded. A read that fails counts as not over.
   */
  readonly isOver?: () => Promise<boolean>;
}

/** What takes a tree's lease: the store, the clock and the instance's audit log. */
export interface LeaseTaking {
  readonly repository: ExecutionLeaseRepository;
  readonly clock: Clock;
  readonly events?: AuditLogWriter | undefined;
  /** Aborted when the instance's stop interrupts what still runs: no release waits past it (#508). */
  readonly stopping?: AbortSignal | undefined;
  /** What the holder takes off each answer's `remaining` (#533); absent: `LEASE_SAFETY_MARGIN`. */
  readonly safetyMargin?: Milliseconds | undefined;
  /** Where the holder counts itself while it holds the lease (#485); absent = not counted. */
  readonly heldLeases?: HeldLeases | undefined;
}

/** Whether a take of `lease` is a takeover the audit log records. */
const isReported = (lease: ExecutionLease, take: LeaseTake | undefined): take is LeaseTake =>
  take !== undefined && (lease.takenOverFrom !== undefined || take.isTakeover === true);

/** Records the take of `lease` when it is a takeover (#501); never throws. */
export async function reportTake(
  events: AuditLogWriter | undefined,
  lease: ExecutionLease,
  take: LeaseTake | undefined,
): Promise<void> {
  if (events === undefined || !isReported(lease, take)) return;
  const checkpointId = await take.checkpointIdOf?.().catch((): undefined => undefined);
  const { recordTakeover } = await events.recording;
  await recordTakeover(events, {
    tenantId: lease.tenantId,
    rootExecutionId: take.rootExecutionId ?? lease.rootExecutionId,
    leaseExecutionId: lease.rootExecutionId,
    scopeKey: scopeKeyOf(lease.tenantId, lease.rootExecutionId),
    token: lease.token,
    holderInstanceId: lease.holderInstanceId,
    previousHolderInstanceId: lease.takenOverFrom?.holderInstanceId,
    previousToken: lease.takenOverFrom?.token,
    checkpointId,
    reason: take.reason,
  });
}

/**
 * The take of a reclaim after a yield (#333 PR 4): always a takeover, at a new token, of the
 * tree `take` (the first take) named.
 */
export const reclaimedOf = (take: LeaseTake | undefined): LeaseTake => ({
  reason: LeaseTakeoverReason.Reclaimed,
  isTakeover: true,
  ...(take?.rootExecutionId === undefined ? {} : { rootExecutionId: take.rootExecutionId }),
});

/** A root thread's checkpoint config, as the head checkpoint is read with it. */
export interface RootThreadConfig {
  readonly configurable: { readonly thread_id: string };
}

/** The part of a checkpoint tuple a takeover reads: the checkpoint's id. */
export interface HeadCheckpoint {
  readonly checkpoint: { readonly id: string };
  /** The writes its tasks made, `[taskId, channel, value]` (#853: a task with one is not lost). */
  readonly pendingWrites?: readonly (readonly [string, string, unknown])[] | undefined;
}

/** What reads a root's head checkpoint: a `BaseCheckpointSaver`. */
export interface HeadCheckpointReader {
  getTuple(config: RootThreadConfig): Promise<HeadCheckpoint | undefined>;
}

/** Where a root's head checkpoint is read (`AppDeps.pause`); absent = not read. */
export interface RootCheckpoints {
  readonly checkpointer: HeadCheckpointReader;
}

/**
 * The take of a root's lease for `reason`, its head checkpoint read only when the take is reported
 * (the root's own thread: its `runId`).
 */
export const rootTakeOf = (
  checkpoints: RootCheckpoints | undefined,
  runId: string,
  reason: LeaseTakeoverReason,
  isTakeover = false,
): LeaseTake => ({
  reason,
  isTakeover,
  ...(checkpoints === undefined
    ? {}
    : {
        checkpointIdOf: async () =>
          (await checkpoints.checkpointer.getTuple({ configurable: { thread_id: runId } }))
            ?.checkpoint.id,
      }),
});
