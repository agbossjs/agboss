import type { Clock } from "../infrastructure/clock.js";
import { scopeKeyOf } from "./lease-lost.js";
import {
  holdOnce,
  SlotQueue,
  type QueueClaim,
  type QueueWatch,
  type SlotHold,
} from "../flow/runtime/launch/slot-queue.js";

/**
 * The instance's cap on steps (#332): `@Application({ maxConcurrentSteps })` — how many agent,
 * router and action steps (a launch's branch too) of this application instance work at once, over
 * every tree and every tenant. One per instance, made in `createApp` when the cap is set (loaded
 * lazily: the root import keeps only the option's type), never per pass. A step takes its tree's
 * slot (#264), then one of these, with the same claim; both are released when it ends, fails or
 * pauses. Without a free slot it waits in the queue of `slot-queue.ts` — a step closing a branch
 * first, then the deepest (aged every `AGING_STEP` on the `Clock`), a new root's first step last —
 * never an error. A step waiting in a model provider's rate-limit queue holds its slot (S1 Q3). A
 * waiter whose signal aborts leaves the queue: a cancel, a `FailFast` launch, the instance's stop
 * past its shutdown timeout (it is handed over and recovered elsewhere, like a running step, Q4).
 *
 * No deadlock: a launch slot is taken before the tree's, the tree's before the instance's, and a
 * child workflow's node takes none — a step holding an instance slot needs nothing else to end.
 * The one exception is a project's own: a tool that calls `app.execute` on the same instance while
 * its step holds a slot waits for a slot of its own.
 */

/** What the readiness probe and the recovery sweep read of the instance's slots. */
export interface StepCapacity {
  /** `@Application({ maxConcurrentSteps })`. */
  readonly maxConcurrentSteps: number;
  /** The steps at work now. */
  busySlots(): number;
  /** The steps waiting for a slot now. */
  waitingSteps(): number;
  /** The slots no step holds now. */
  freeSlots(): number;
  /**
   * Whether a step under the lease `holder` (its `scopeKey`: a root's, or an AnyInstance child's
   * own, #471) holds a slot now (#767): what the child workers read so a claimed child at work is
   * counted once — by its slot, not again as a claim.
   */
  holdsSlot(holder: string): boolean;
}

/** The instance's step slots: a priority semaphore of `maxConcurrentSteps` steps. */
export class StepSlots implements StepCapacity {
  #busy = 0;
  /** The slots held now per lease (`scopeKey`), for `holdsSlot`; a lease with none is absent. */
  readonly #heldBy = new Map<string, number>();
  readonly #queue: SlotQueue<QueueClaim>;

  constructor(
    readonly maxConcurrentSteps: number,
    clock: Clock,
  ) {
    this.#queue = new SlotQueue(clock);
  }

  busySlots(): number {
    return this.#busy;
  }

  waitingSteps(): number {
    return this.#queue.size;
  }

  freeSlots(): number {
    return this.maxConcurrentSteps - this.#busy;
  }

  holdsSlot(holder: string): boolean {
    return this.#heldBy.has(holder);
  }

  /**
   * Takes a slot for one step — of the lease `holder` (its `scopeKey`), when it runs under one;
   * `undefined` when `signal` aborts first.
   */
  take(
    claim: QueueClaim,
    signal: AbortSignal,
    watch?: QueueWatch,
    holder?: string,
  ): Promise<SlotHold | undefined> {
    if (signal.aborted) return Promise.resolve(undefined);
    if (this.#canWork()) return Promise.resolve(this.#hold(holder));
    return this.#queue.wait(claim, signal, () => this.#hold(holder), watch);
  }

  #canWork(): boolean {
    return this.#busy < this.maxConcurrentSteps;
  }

  #hold(holder: string | undefined): SlotHold {
    this.#busy += 1;
    if (holder !== undefined) this.#heldBy.set(holder, (this.#heldBy.get(holder) ?? 0) + 1);
    return holdOnce(() => {
      this.#busy -= 1;
      if (holder !== undefined) this.#unhold(holder);
      this.#queue.grantReady(() => this.#canWork());
    });
  }

  #unhold(holder: string): void {
    const held = (this.#heldBy.get(holder) ?? 0) - 1;
    if (held > 0) this.#heldBy.set(holder, held);
    else this.#heldBy.delete(holder);
  }
}

/**
 * The children a worker may claim now (#767): its free step slots less one for each claimed child
 * that holds none at the moment — before its first step, or between two — since it takes one again.
 * A child at work is already counted by its slot (`holdsSlot`, by its own lease's `scopeKey`), never
 * a second time as a claim: an instance of N free slots claims up to N, and never more children
 * than its slots. No cap → no limit.
 */
export function claimRoomOf(
  capacity: StepCapacity | undefined,
  claimed: Iterable<{ readonly tenantId: string; readonly executionId: string }>,
): number {
  if (capacity === undefined) return Number.POSITIVE_INFINITY;
  let between = 0;
  for (const { tenantId, executionId } of claimed)
    if (!capacity.holdsSlot(scopeKeyOf(tenantId, executionId))) between += 1;
  return capacity.freeSlots() - between;
}
