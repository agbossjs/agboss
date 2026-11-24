import { Injectable } from "../components/decorators.js";
import type { Milliseconds } from "../units/index.js";
import type { InterruptMode } from "../app/interrupt-types.js";
import type { NewStatusTransition } from "../turns/index.js";
import type { ExecutionTree } from "./execution-tree.repository.js";
import { ApplicationContext } from "../flow/context/application-context.js";
import { StoreClock } from "./clock.js";
import {
  remainingOf,
  takenOverFromOf,
  type ExecutionIdentity,
  type ExecutionLease,
  type PauseMarks,
  type PauseRequest,
  type StopMark,
  type TreeMarks,
  type StoreDescriptor,
} from "./execution-lease-contract.js";
import { InMemoryClusterMirror } from "./in-memory-cluster-mirror.js";
import { inMemoryPauseOf, pausedInMemory, unpausedInMemory } from "./in-memory-pause-mark.js";
import {
  inMemoryStopOf,
  isInMemoryCancelMarked,
  markedInMemoryCancel,
  markedInMemoryStop,
  markOf,
} from "./in-memory-cancel-mark.js";
import {
  IN_MEMORY_DATABASE,
  treeKeyOf,
  type ExecutionLeaseRow,
  type InMemoryDatabase,
} from "./in-memory-database.js";

// the contract and its types live beside the in-memory default, as one module to every importer
export * from "./execution-lease-contract.js";

/** Whether `acquire` refuses a stored lease: still held, or retired (#520). */
const isRefused = (stored: ExecutionLeaseRow, now: Date): boolean =>
  stored.isRetired === true || (!stored.released && isLiveAt(stored.lease, now));

/**
 * Whether a lease is live at `now` (#534): while `expiresAt > now`, and only then — the one boundary
 * of every check of a lease (`acquire`, `renew`, `yield`, `reclaim`, a fenced write, `leaseStateOf`).
 */
export const isLiveAt = (lease: { readonly expiresAt: Date }, now: Date): boolean =>
  lease.expiresAt.getTime() > now.getTime();

/** Whether `stored` is the very lease the caller holds (its holder and epoch). */
const isSameLease = (stored: ExecutionLease, held: ExecutionLease): boolean =>
  stored.token === held.token && stored.holderInstanceId === held.holderInstanceId;

/**
 * The built-in default: leases in this instance's memory — every operation is one synchronous
 * step, so it is atomic. With one instance nothing contends; the instances of one test share it. A
 * yielded lease is its row with `isYielded` (#516): read by nothing but the people looking at it; a
 * retired one (#520) its released row with `isRetired`, never acquired again. Every execution id
 * handed out is a row of `executionIds` (#591), kept for the instance's life.
 */
@Injectable({ deps: [StoreClock, ApplicationContext, IN_MEMORY_DATABASE] })
export class InMemoryExecutionLeaseRepository extends InMemoryClusterMirror {
  static override readonly store: StoreDescriptor = { backend: "in-memory" };

  constructor(
    private readonly clock: Pick<StoreClock, "now">,
    private readonly applicationContext: ApplicationContext,
    database: InMemoryDatabase,
  ) {
    super(database);
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }

  claimExecutionId(identity: ExecutionIdentity): Promise<boolean> {
    const { executionIds } = this.database;
    if (executionIds.has(identity.executionId)) return Promise.resolve(false);
    executionIds.add(identity.executionId);
    return Promise.resolve(true);
  }

  acquire(
    tenantId: string,
    rootExecutionId: string,
    duration: Milliseconds,
  ): Promise<ExecutionLease | undefined> {
    const key = treeKeyOf(tenantId, rootExecutionId);
    const now = this.clock.now();
    const stored = this.database.executionLeases.get(key);
    if (stored !== undefined && isRefused(stored, now)) return Promise.resolve(undefined);
    const taken: ExecutionLease = {
      tenantId,
      rootExecutionId,
      holderInstanceId: this.applicationContext.instanceId,
      token: (stored?.lease.token ?? 0) + 1,
      expiresAt: new Date(now.getTime() + duration),
      remaining: duration,
      // held is false here: a stored lease not released has expired; a superseded one had (#508)
      ...takenOverFromOf(
        stored?.lease,
        stored?.released === false || stored?.isClosedByCheck === true,
      ),
    };
    this.database.executionLeases.set(key, { lease: taken, released: false, ...markOf(stored) });
    return Promise.resolve(taken);
  }

  renew(executionLease: ExecutionLease, duration: Milliseconds): Promise<Milliseconds | undefined> {
    const key = treeKeyOf(executionLease.tenantId, executionLease.rootExecutionId);
    const stored = this.#heldOf(key, executionLease);
    if (stored === undefined) return Promise.resolve(undefined);
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + duration);
    this.database.executionLeases.set(key, { ...stored, lease: { ...stored.lease, expiresAt } });
    return Promise.resolve(remainingOf(expiresAt, now));
  }

  release(executionLease: ExecutionLease): Promise<void> {
    this.#released(executionLease, false);
    return Promise.resolve();
  }

  retire(executionLease: ExecutionLease): Promise<void> {
    this.#released(executionLease, true);
    return Promise.resolve();
  }

  /** Releases the caller's own lease — for good when `isRetired` (#520); another's is kept. */
  #released(executionLease: ExecutionLease, isRetired: boolean): void {
    const key = treeKeyOf(executionLease.tenantId, executionLease.rootExecutionId);
    const stored = this.database.executionLeases.get(key);
    if (stored === undefined || !isSameLease(stored.lease, executionLease)) return;
    const retired = isRetired || stored.isRetired === true;
    this.database.executionLeases.set(key, {
      lease: stored.lease,
      released: true,
      ...(retired ? { isRetired: true } : {}),
      ...markOf(stored),
    });
  }

  yield(executionLease: ExecutionLease): Promise<Milliseconds | undefined> {
    const key = treeKeyOf(executionLease.tenantId, executionLease.rootExecutionId);
    const stored = this.#heldOf(key, executionLease);
    if (stored === undefined) return Promise.resolve(undefined);
    this.database.executionLeases.set(key, { ...stored, isYielded: true });
    return Promise.resolve(remainingOf(stored.lease.expiresAt, this.clock.now()));
  }

  reclaim(
    executionLease: ExecutionLease,
    duration: Milliseconds,
  ): Promise<ExecutionLease | undefined> {
    const key = treeKeyOf(executionLease.tenantId, executionLease.rootExecutionId);
    const stored = this.#heldOf(key, executionLease);
    if (stored === undefined) return Promise.resolve(undefined);
    const { tenantId, rootExecutionId, holderInstanceId } = stored.lease;
    const expiresAt = new Date(this.clock.now().getTime() + duration);
    const token = stored.lease.token + 1;
    const reclaimed = {
      ...{ tenantId, rootExecutionId, holderInstanceId, token, expiresAt },
      remaining: duration,
    };
    this.database.executionLeases.set(key, {
      lease: reclaimed,
      released: false,
      ...markOf(stored),
    });
    return Promise.resolve(reclaimed);
  }

  requestCancel(tree: ExecutionTree, transition?: NewStatusTransition): Promise<void> {
    return markedInMemoryCancel(this.database, tree, this.clock.now().getTime(), transition);
  }

  isCancelRequested(tree: ExecutionTree): Promise<boolean> {
    return Promise.resolve(isInMemoryCancelMarked(this.database, tree));
  }

  requestStop(
    tree: ExecutionTree,
    mode: InterruptMode,
    transition?: NewStatusTransition,
  ): Promise<void> {
    const now = this.clock.now().getTime();
    return markedInMemoryStop(this.database, tree, {
      mode,
      now,
      ...(transition ? { transition } : {}),
    });
  }

  stopOf(tree: ExecutionTree): Promise<StopMark | undefined> {
    return Promise.resolve(inMemoryStopOf(this.database, tree));
  }

  override markedOf(tree: ExecutionTree): Promise<TreeMarks> {
    const stop = inMemoryStopOf(this.database, tree);
    const isCancelRequested = isInMemoryCancelMarked(this.database, tree);
    const paused = inMemoryPauseOf(this.database, tree);
    return Promise.resolve({
      isCancelRequested,
      ...(stop === undefined ? {} : { stop }),
      ...paused,
    });
  }

  requestPause(
    tree: ExecutionTree,
    request: PauseRequest,
    transition?: NewStatusTransition,
  ): Promise<void> {
    const now = this.clock.now().getTime();
    return pausedInMemory(this.database, tree, {
      request,
      now,
      ...(transition ? { transition } : {}),
    });
  }

  unpause(tree: ExecutionTree, transition?: NewStatusTransition): Promise<void> {
    const now = this.clock.now().getTime();
    return unpausedInMemory(this.database, tree, { now, ...(transition ? { transition } : {}) });
  }

  pauseOf(tree: ExecutionTree): Promise<PauseMarks> {
    return Promise.resolve(inMemoryPauseOf(this.database, tree));
  }

  /**
   * The stored row of `key` while it is still `held` and live (#534: `expiresAt > now`) — as
   * `renew`, `yield` and `reclaim` find it; `undefined` otherwise.
   */
  #heldOf(key: string, held: ExecutionLease): ExecutionLeaseRow | undefined {
    const stored = this.database.executionLeases.get(key);
    const isHeld =
      stored !== undefined &&
      !stored.released &&
      isSameLease(stored.lease, held) &&
      isLiveAt(stored.lease, this.clock.now());
    return isHeld ? stored : undefined;
  }
}
