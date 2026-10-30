import { SystemClock } from "../infrastructure/clock.js";
import { seconds, type Milliseconds } from "../units/index.js";
import { AppCloseTimeoutError } from "./errors.js";

/**
 * How long a test's teardown waits, in real time, for one app to close (#509). Closing waits for
 * the executions still running; one that never ends — its step frozen, its lease stalled, its
 * shutdown timeout on a `VirtualClock` nobody advances once the test is over — would hang the run:
 * vitest bounds a test's body, never a fixture's teardown.
 */
export const CLOSE_TIMEOUT = seconds(10);

/** The real clock the bound reads: a test's own time never moves by itself. */
const REAL_TIME = new SystemClock();

/** `closing`, or `AppCloseTimeoutError` naming the instance after `timeout` of real time. */
export async function closedWithin(
  closing: Promise<void>,
  instance: number,
  timeout: Milliseconds = CLOSE_TIMEOUT,
): Promise<void> {
  const timer = new AbortController();
  const isClosed = await Promise.race([
    closing.then(() => true),
    REAL_TIME.sleep(timeout, timer.signal).then(() => false),
  ]).finally(() => {
    timer.abort();
  });
  if (!isClosed) throw new AppCloseTimeoutError(instance, timeout);
}
