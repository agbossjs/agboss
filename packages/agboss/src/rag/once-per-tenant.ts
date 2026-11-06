/**
 * One piece of work per tenant per instance (#818: a knowledge base's first look at a tenant's
 * index), run by the first caller and joined by the callers that come while it runs. Each caller
 * waits under its own signal: its abort stops its wait, never the work. Work that failed is not
 * done — the next caller runs it again —, and a caller that was only waiting runs it itself when the
 * failure was the first caller's abort, or gets the same failure when the work failed of itself.
 */
export class OncePerTenant {
  readonly #runs = new Map<string, Run>();

  constructor(private readonly work: (tenantId: string, signal: AbortSignal) => Promise<void>) {}

  async run(tenantId: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const running = this.#runs.get(tenantId);
    if (running === undefined) return this.#start(tenantId, signal);
    try {
      await untilAborted(running.done, signal);
    } catch (error) {
      signal.throwIfAborted();
      if (!running.signal.aborted) throw error;
      // the caller that ran it gave up: its run is no run — never wait on it twice
      if (this.#runs.get(tenantId) === running) this.#runs.delete(tenantId);
      return this.run(tenantId, signal);
    }
  }

  async #start(tenantId: string, signal: AbortSignal): Promise<void> {
    const run: Run = { done: this.work(tenantId, signal), signal };
    this.#runs.set(tenantId, run);
    try {
      await run.done;
    } catch (error) {
      if (this.#runs.get(tenantId) === run) this.#runs.delete(tenantId);
      throw error;
    }
  }
}

/** A tenant's work in flight, and the signal of the caller that runs it. */
interface Run {
  readonly done: Promise<void>;
  readonly signal: AbortSignal;
}

/** `work`'s outcome, or the signal's reason as soon as it aborts — the work itself goes on. */
function untilAborted(work: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      reject(signal.reason as Error);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error as Error);
      },
    );
  });
}
