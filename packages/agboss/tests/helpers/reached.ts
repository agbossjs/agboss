import { performance } from "node:perf_hooks";

/**
 * Waits until `isReached()` — a step parked at a test's gate, say — turn after turn of the event
 * loop, bounded by real time, not by a count of turns: on a cold, loaded runner the step may first
 * load a module the protocol imports on its first call (real I/O, no turn of its own), so a count
 * of turns can run out before it gets there (#508: CI). Fails naming `what` after `timeout` ms.
 */
export async function untilReached(
  isReached: () => boolean,
  what: string,
  timeout = 10_000,
): Promise<void> {
  const deadline = performance.now() + timeout;
  while (!isReached()) {
    if (performance.now() > deadline) throw new Error(`${what} within ${String(timeout)} ms`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}
