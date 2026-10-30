import { scopeKeyOf } from "./lease-lost.js";
import type * as LeaseEvents from "./lease-events.js";
import type { HandOverReport } from "./lease-events.js";
import type { ObservabilityMask } from "../pii/observability-mask.js";
import type { FrameworkLog } from "../infrastructure/logger.js";
import type { Infrastructure } from "../infrastructure/contracts.js";
import type { EventMask, ExecutionObserverManager } from "../core/observer-manager.js";
import {
  LeaseTakeoverReason,
  type ExecutionLeaseEventRepository,
} from "../infrastructure/execution-lease-event.repository.js";
import type {
  ExecutionLease,
  ExecutionLeaseRepository,
} from "../infrastructure/execution-lease.repository.js";
import { treeKeyOf } from "../infrastructure/in-memory-database.js";
import type { ExecutionTree } from "../infrastructure/execution-tree.repository.js";
import type { Clock } from "../infrastructure/clock.js";
import { seconds, type Milliseconds } from "../units/index.js";
import type { FrameLease } from "../flow/context/frame.js";
import { HeldLease } from "./held-lease.js";
import { EXECUTION_LEASE } from "./lease-fence.js";
import { leaseReleases } from "./lease-releases.js";

/**
 * Who moves an execution tree (#265, Q58): `app.execute` / `app.resume` hold the tree's lease
 * while they move it, renew it in the background every third of its length and right before
 * every checkpoint write, and release it when the pass ends (paused, finished or failed). While a
 * parent node awaits remote children in-step (#333 PR 4, S9 Q1), it yields the lease in
 * `ExecutionLeaseRepository` and re-acquires it before continuing.
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
  renewNow(): Promise<void>;
  /**
   * Runs `check` after every renewal the store confirmed — the background one, the one before a
   * checkpoint write and `confirmNow()` (#360: the holder looks for a cancel request); `check` never
   * throws.
   */
  afterEachRenewal(check: RenewalCheck): void;
  /**
   * Yields the lease in `ExecutionLeaseRepository` while `wait` awaits remote children (#333 PR 4,
   * S9 Q1) — only while no other step of the tree runs (#471) — and re-acquires it before
   * returning so `.join()` and checkpoint writes run under it.
   */
  yieldWhile<T>(wait: () => Promise<T>): Promise<T>;
  /** Stops renewing and gives the lease up (nothing to give when it was lost). */
  release(): Promise<void>;
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
}

/** What a holder records its takeovers with: the instance's lease log, absent = none. */
export interface LeaseTakeoverLog {
  readonly events?: LeaseEventLog | undefined;
}

export function executionLeasesOf(
  repository: ExecutionLeaseRepository,
  clock: Clock,
  { events }: LeaseTakeoverLog = {},
): ExecutionLeases {
  const take = (tree: ExecutionTree, why?: LeaseTake): Promise<HeldExecutionLease | undefined> =>
    takeLease({ repository, clock, events }, tree, why);
  return {
    tryHold: take,
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
  const askedAt = clock.now().getTime();
  const initial = await repository.acquire(tree.tenantId, tree.rootExecutionId, EXECUTION_LEASE);
  if (initial === undefined) return undefined;
  const held = new HeldLease(taking, tree, initial, { askedAt, take });
  await reportTake(events, initial, take);
  return held;
}

/**
 * Which takes of a tree's lease are takeovers, and their record in the lease log (#501); the
 * recording itself (`lease-events.ts`) is not in the root import: an instance starts loading it
 * when it builds its lease log, so a takeover never waits for a module.
 */

/** What an instance records its lease events with. */
export interface LeaseEventLog {
  readonly repository: ExecutionLeaseEventRepository;
  /** The application's observers, unmasked: they get the event as `mask` shows it. */
  readonly observer: ExecutionObserverManager;
  /** What an event and its row show (the application's PII observability mask). */
  readonly mask: EventMask;
  readonly log: FrameworkLog;
  readonly clock: Clock;
  /** The recording (`lease-events.ts`), loading since the instance was built. */
  readonly recording: Promise<typeof LeaseEvents>;
}

/** What an instance's lease log is made of besides its infrastructure. */
export interface LeaseEventParts {
  readonly observer: ExecutionObserverManager;
  /** The application's PII observability mask. */
  readonly mask: ObservabilityMask;
  readonly log: FrameworkLog;
}

/** The instance's lease log: its store and clock, its observers, the application's mask. */
export const leaseEventLogOf = (
  infrastructure: Pick<Infrastructure, "leaseEvents" | "clock">,
  { observer, mask, log }: LeaseEventParts,
): LeaseEventLog => ({
  repository: infrastructure.leaseEvents,
  observer,
  mask: (event) => mask.value(event),
  log,
  clock: infrastructure.clock,
  recording: import("./lease-events.js"),
});

/**
 * Why a site takes a tree's lease, for the lease log (#501): a take is reported as a takeover when
 * the store names the holder whose lease expired (`takenOverFrom`), and at every take of a site
 * that continues a tree another pass was moving (`isTakeover`: the recovery sweep, a remote child's
 * reclaim, a re-acquire after a yield) — there `previousHolder…` only when the store names it.
 */
export interface LeaseTake {
  readonly reason: LeaseTakeoverReason;
  readonly isTakeover?: boolean;
  /** The tree's root when the lease is a remote child's own; default the lease's execution. */
  readonly rootExecutionId?: string;
  /** The tree's head checkpoint, read only when the take is reported. */
  readonly checkpointIdOf?: () => Promise<string | undefined>;
}

/** What takes a tree's lease: the store, the clock and the instance's lease log. */
export interface LeaseTaking {
  readonly repository: ExecutionLeaseRepository;
  readonly clock: Clock;
  readonly events?: LeaseEventLog | undefined;
}

/** Whether a take of `lease` is a takeover the lease log records. */
const isReported = (lease: ExecutionLease, take: LeaseTake | undefined): take is LeaseTake =>
  take !== undefined && (lease.takenOverFrom !== undefined || take.isTakeover === true);

/** Records the take of `lease` when it is a takeover (#501); never throws. */
export async function reportTake(
  events: LeaseEventLog | undefined,
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
    token: lease.leaseEpoch,
    holderInstanceId: lease.holderInstanceId,
    previousHolderInstanceId: lease.takenOverFrom?.holderInstanceId,
    previousToken: lease.takenOverFrom?.leaseEpoch,
    checkpointId,
    reason: take.reason,
  });
}

/**
 * The take of a re-acquire after a yield (#333 PR 4): always a takeover, at a new token, of the
 * tree `take` (the first take) named.
 */
export const reacquiredOf = (take: LeaseTake | undefined): LeaseTake => ({
  reason: LeaseTakeoverReason.Reacquired,
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

/**
 * The hand-overs a held lease records (#501): each written through the instance's lease log, the
 * lease released only once they were — so the moving call rejects after its rows exist.
 */
export class HandOverReports {
  readonly #pending = new Set<Promise<void>>();
  #holder: Pick<ExecutionLease, "holderInstanceId" | "leaseEpoch"> | undefined;

  /** The lease now held: its holder and token name a later hand-over. */
  held(lease: ExecutionLease): void {
    this.#holder = lease;
  }

  record(events: LeaseEventLog | undefined, report: HandOverReport, scopeKey: string): void {
    const holder = this.#holder;
    if (events === undefined || holder === undefined) return;
    const lease = { scopeKey, holderInstanceId: holder.holderInstanceId, token: holder.leaseEpoch };
    const written = events.recording.then(({ recordHandOver }) =>
      recordHandOver(events, report, lease),
    );
    this.#pending.add(written);
    void written.finally(() => this.#pending.delete(written));
  }

  /** Once every hand-over recorded so far is written (recording never rejects). */
  async settled(): Promise<void> {
    await Promise.all([...this.#pending]);
  }
}
