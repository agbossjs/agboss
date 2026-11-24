/**
 * One piece of work per scope per instance (#818: a knowledge base's first look at a scope's
 * index), run by the first caller and joined by the callers that come while it runs. Each caller
 * waits under its own signal: its abort stops its wait, never the work. Work that failed is not
 * done — the next caller runs it again —, and a caller that was only waiting runs it itself when the
 * failure was the first caller's abort, or gets the same failure when the work failed of itself.
 */
export class OncePerScope {
  readonly #runs = new Map<string, Run>();

  constructor(private readonly work: (scopeId: string, signal: AbortSignal) => Promise<void>) {}

  async run(scopeId: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const running = this.#runs.get(scopeId);
    if (running === undefined) return this.#start(scopeId, signal);
    try {
      await untilAborted(running.done, signal);
    } catch (error) {
      signal.throwIfAborted();
      if (!running.signal.aborted) throw error;
      // the caller that ran it gave up: its run is no run — never wait on it twice
      if (this.#runs.get(scopeId) === running) this.#runs.delete(scopeId);
      return this.run(scopeId, signal);
    }
  }

  async #start(scopeId: string, signal: AbortSignal): Promise<void> {
    const run: Run = { done: this.work(scopeId, signal), signal };
    this.#runs.set(scopeId, run);
    try {
      await run.done;
    } catch (error) {
      if (this.#runs.get(scopeId) === run) this.#runs.delete(scopeId);
      throw error;
    }
  }
}

/** A scope's work in flight, and the signal of the caller that runs it. */
interface Run {
  readonly done: Promise<void>;
  readonly signal: AbortSignal;
}

/** `work`'s outcome, or the signal's reason as soon as it aborts — the work itself goes on. */
async function untilAborted(work: Promise<void>, signal: AbortSignal): Promise<void> {
  const abort: { listener?: () => void } = {};
  const aborted = new Promise<never>((_, reject) => {
    abort.listener = () => {
      reject(signal.reason as Error);
    };
    signal.addEventListener("abort", abort.listener, { once: true });
  });
  try {
    await Promise.race([work, aborted]);
  } finally {
    if (abort.listener !== undefined) signal.removeEventListener("abort", abort.listener);
  }
}
