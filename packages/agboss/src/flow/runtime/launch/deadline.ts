import type { Clock } from "../../../infrastructure/clock.js";
import type { Milliseconds } from "../../../units/index.js";

/**
 * A quorum's deadline (#279 S26, AC10): `deadlineAt` is computed once, at dispatch, from the
 * application's `Clock` and kept in the launch's ticket (state and every branch's payload), so a
 * resume and a recovery keep it; a `Clock` sleep per launch in this process ends the quorum at that
 * moment. A pause counts as elapsed time. Waiting in our own queues (#264 / #266) is excluded when
 * those queues exist; until then nothing extends it.
 */

/** When a launch's quorum ends: `deadline` after `now`, in epoch milliseconds. */
export const deadlineAtOf = (now: Date, deadline: Milliseconds): number => now.getTime() + deadline;

/** Whether `deadlineAt` has passed on the clock. */
export const hasExpired = (clock: Clock, deadlineAt: number): boolean =>
  clock.now().getTime() >= deadlineAt;

/** How long until `deadlineAt` (0 when it passed) — a duration on the clock, validated here. */
const untilDeadline = (clock: Clock, deadlineAt: number): Milliseconds =>
  Math.max(0, deadlineAt - clock.now().getTime()) as Milliseconds;

/**
 * Calls `onExpire` at `deadlineAt`, unless `stop` aborts first (the launch decided or was read by
 * its join). Never rejects.
 */
export function watchDeadline(
  clock: Clock,
  deadlineAt: number,
  stop: AbortSignal,
  onExpire: () => void,
): void {
  void clock.sleep(untilDeadline(clock, deadlineAt), stop).then(() => {
    if (!stop.aborted) onExpire();
  });
}
