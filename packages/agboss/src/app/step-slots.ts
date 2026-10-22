import type { Clock } from "../infrastructure/clock.js";
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
}

/** The instance's step slots: a priority semaphore of `maxConcurrentSteps` steps. */
export class StepSlots implements StepCapacity {
  #busy = 0;
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

  /** Takes a slot for one step; `undefined` when `signal` aborts first. */
  take(claim: QueueClaim, signal: AbortSignal, watch?: QueueWatch): Promise<SlotHold | undefined> {
    if (signal.aborted) return Promise.resolve(undefined);
    if (this.#canWork()) return Promise.resolve(this.#hold());
    return this.#queue.wait(claim, signal, () => this.#hold(), watch);
  }

  #canWork(): boolean {
    return this.#busy < this.maxConcurrentSteps;
  }

  #hold(): SlotHold {
    this.#busy += 1;
    return holdOnce(() => {
      this.#busy -= 1;
      this.#queue.grantReady(() => this.#canWork());
    });
  }
}
