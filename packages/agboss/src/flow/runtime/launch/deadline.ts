import type { Clock } from "../../../infrastructure/clock.js";
import type { Milliseconds } from "../../../units/index.js";
import type { QueueWatch } from "./slot-queue.js";

/**
 * A quorum's deadline (#279 S26, AC10): `deadlineAt` is computed once, at dispatch, from the
 * application's `Clock` and kept in the launch's ticket (state and every branch's payload), so a
 * resume and a recovery keep it; a `Clock` sleep per launch in this process ends the quorum at that
 * moment. A pause counts as elapsed time; waiting in the tree's queue (#264 `maxConcurrentExecutions`)
 * does not — it moves the deadline in this process (`QueueTime`).
 */

/**
 * The time a quorum's branches spend in the tree's queue (#264 AC9, #279 S26): a quorum's
 * `deadline` is about waiting for work, not for our own throttle, so the time while its branches
 * wait for a tree slot — at least one waiting, the execution holding none — does not count. Kept
 * in-process with the launch's entry, read from the application's `Clock`; a pass after a resume or a
 * crash starts it again from 0 (the queue lives in one process).
 */
export class QueueTime implements QueueWatch {
  #waiting = 0;
  #since: number | undefined;
  #excluded = 0;
  readonly #resumed: (() => void)[] = [];

  constructor(private readonly clock: Clock) {}

  /** A branch starts waiting for a tree slot. */
  enter(): void {
    if (this.#waiting === 0) this.#since = this.clock.now().getTime();
    this.#waiting += 1;
  }

  /** A branch stops waiting: it took a slot, or left the queue. */
  leave(): void {
    this.#waiting -= 1;
    if (this.#waiting > 0 || this.#since === undefined) return;
    this.#excluded += this.clock.now().getTime() - this.#since;
    this.#since = undefined;
    for (const wake of this.#resumed.splice(0)) wake();
  }

  /** Whether a branch waits now. */
  isWaiting(): boolean {
    return this.#waiting > 0;
  }

  /** The time in the queue so far, in milliseconds: the deadline moves by it. */
  excluded(): number {
    const open = this.#since === undefined ? 0 : this.clock.now().getTime() - this.#since;
    return this.#excluded + open;
  }

  /** Resolves when no branch waits any more, or when `stop` aborts. */
  whenResumed(stop: AbortSignal): Promise<void> {
    if (!this.isWaiting() || stop.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = (): void => {
        stop.removeEventListener("abort", done);
        resolve();
      };
      this.#resumed.push(done);
      stop.addEventListener("abort", done, { once: true });
    });
  }
}

/** When a launch's quorum ends: `deadline` after `now`, in epoch milliseconds. */
export const deadlineAtOf = (now: Date, deadline: Milliseconds): number => now.getTime() + deadline;

/** Whether `deadlineAt` has passed on the clock. */
export const hasExpired = (clock: Clock, deadlineAt: number): boolean =>
  clock.now().getTime() >= deadlineAt;

/** How long until `deadlineAt` (0 when it passed) — a duration on the clock, validated here. */
const untilDeadline = (clock: Clock, deadlineAt: number): Milliseconds =>
  Math.max(0, deadlineAt - clock.now().getTime()) as Milliseconds;

/** Resolves `true` at the deadline, moved by the time in the tree's queue; `false` once `stop` aborts. */
async function expiry(
  clock: Clock,
  deadlineAt: number,
  stop: AbortSignal,
  queued: QueueTime,
): Promise<boolean> {
  while (!stop.aborted) {
    if (queued.isWaiting()) await queued.whenResumed(stop);
    else {
      const due = deadlineAt + queued.excluded();
      if (clock.now().getTime() >= due) return true;
      await clock.sleep(untilDeadline(clock, due), stop);
    }
  }
  return false;
}

/**
 * Calls `onExpire` at `deadlineAt` — later by the time the launch's branches waited in the tree's
 * queue (#264), never while they wait — unless `stop` aborts first (the launch decided or was read
 * by its join). Never rejects.
 */
export function watchDeadline(
  clock: Clock,
  deadlineAt: number,
  stop: AbortSignal,
  queued: QueueTime,
  onExpire: () => void,
): void {
  void expiry(clock, deadlineAt, stop, queued).then((isExpired) => {
    if (isExpired && !stop.aborted) onExpire();
  });
}
