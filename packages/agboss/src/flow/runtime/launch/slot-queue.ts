import type { Clock } from "../../../infrastructure/clock.js";
import { seconds, type Milliseconds } from "../../../units/index.js";

/**
 * The queue of the framework's slot caps (#264 S27, #332): the steps that wait for a slot of their
 * tree (`TreeSlots`, `@Workflow({ maxConcurrentExecutions })`) or of their application instance
 * (`StepSlots`, `@Application({ maxConcurrentSteps })`), in one order — a step that closes a branch
 * (it comes right after its execution's child, or its children's join) first, then the deepest
 * execution, every `AGING_STEP` of waiting counted as one level deeper (read from the application's
 * `Clock` when a slot frees), then the first come. A new root's first step is depth 1: naturally
 * last. Generic over what a holder counts: the cap decides whether a claim may work now, the queue
 * only keeps the order. A waiter whose signal aborts (a cancel, a `FailFast` launch, the instance's
 * stop past its shutdown timeout) leaves the queue.
 */

/** Every 10 s of waiting counts as one level deeper: a framework constant, not a setting. */
export const AGING_STEP: Milliseconds = seconds(10);

/** A step's place in a queue: its execution's depth and whether it closes a branch. */
export interface QueueClaim {
  /** The execution's depth in its tree, from 1 at the root. */
  readonly depth: number;
  /** Its children have all finished: the step closes a branch of the tree. */
  readonly closesBranch: boolean;
}

/** Told when a claim starts and stops waiting: a quorum's deadline excludes that time (#279). */
export interface QueueWatch {
  enter(): void;
  leave(): void;
}

/** A slot taken for one step: released once, when the step ends. */
export interface SlotHold {
  release(): void;
}

interface Waiter<TClaim extends QueueClaim> {
  readonly claim: TClaim;
  readonly enqueuedAt: number;
  readonly sequence: number;
  readonly grant: () => void;
}

/** The waiting claims of one cap, best first. */
export class SlotQueue<TClaim extends QueueClaim> {
  readonly #waiting: Waiter<TClaim>[] = [];
  #sequence = 0;

  constructor(private readonly clock: Clock) {}

  /** How many claims wait now. */
  get size(): number {
    return this.#waiting.length;
  }

  /**
   * Waits until `grantReady` grants `claim`: `hold` takes its slot then, synchronously (so the next
   * claim sees it taken); `undefined` when `signal` aborts first.
   */
  wait(
    claim: TClaim,
    signal: AbortSignal,
    hold: () => SlotHold,
    watch?: QueueWatch,
  ): Promise<SlotHold | undefined> {
    if (signal.aborted) return Promise.resolve(undefined);
    return new Promise<SlotHold | undefined>((resolve) => {
      const leave = (): void => {
        this.#waiting.splice(this.#waiting.indexOf(waiter), 1);
        watch?.leave();
        resolve(undefined);
      };
      const waiter: Waiter<TClaim> = {
        claim,
        enqueuedAt: this.clock.now().getTime(),
        sequence: (this.#sequence += 1),
        grant: (): void => {
          signal.removeEventListener("abort", leave);
          watch?.leave();
          resolve(hold());
        },
      };
      this.#waiting.push(waiter);
      watch?.enter();
      signal.addEventListener("abort", leave, { once: true });
    });
  }

  /** Grants the waiting claims that `canWork` lets in now, best first (each granted one counted). */
  grantReady(canWork: (claim: TClaim) => boolean): void {
    for (let next = this.#next(canWork); next !== undefined; next = this.#next(canWork)) {
      this.#waiting.splice(this.#waiting.indexOf(next), 1);
      next.grant();
    }
  }

  /** The waiting claims, best first (a cap that takes its room asynchronously walks them). */
  waitingClaims(): readonly TClaim[] {
    const now = this.clock.now().getTime();
    return [...this.#waiting]
      .sort((first, second) => compareWaiters(first, second, now))
      .map((waiter) => waiter.claim);
  }

  #next(canWork: (claim: TClaim) => boolean): Waiter<TClaim> | undefined {
    const now = this.clock.now().getTime();
    const ready = this.#waiting.filter((waiter) => canWork(waiter.claim));
    return ready.sort((first, second) => compareWaiters(first, second, now))[0];
  }
}

/** A waiter's level in the queue: its depth, one deeper per `AGING_STEP` waited. */
const levelOf = (waiter: Waiter<QueueClaim>, now: number): number =>
  waiter.claim.depth + Math.floor((now - waiter.enqueuedAt) / AGING_STEP);

/** Queue order: a branch closing first, then the deepest (aged) level, then the first come. */
function compareWaiters(
  first: Waiter<QueueClaim>,
  second: Waiter<QueueClaim>,
  now: number,
): number {
  const closing = Number(second.claim.closesBranch) - Number(first.claim.closesBranch);
  if (closing !== 0) return closing;
  const level = levelOf(second, now) - levelOf(first, now);
  return level !== 0 ? level : first.sequence - second.sequence;
}

/** A hold released once: `release` runs on the first call only. */
export function holdOnce(release: () => void): SlotHold {
  let isReleased = false;
  return {
    release: (): void => {
      if (isReleased) return;
      isReleased = true;
      release();
    },
  };
}
