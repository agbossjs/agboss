/** How long a test waits for background work, in real time: below vitest's 5 s, so it is named. */
export const UNTIL_TIMEOUT = 4000;

/** `until` gave up: the background work it waited for did not happen in time. */
export class NotReachedError extends Error {
  override name = "NotReachedError";
}

/**
 * Waits one event-loop turn at a time until `isMet()` holds, bounded in real time (#509) — never
 * by a count of turns: a loaded machine spends 2000 turns in a few milliseconds, before a cold
 * execution's lazy imports or its SQLite file are done, and the test then fails or leaves a run
 * behind that freezes after its gates were let go.
 */
export async function until(
  isMet: () => boolean,
  what: string,
  timeout: number = UNTIL_TIMEOUT,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!isMet()) {
    if (Date.now() > deadline) {
      throw new NotReachedError(`${what} within ${String(timeout)} ms of real time`);
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}
