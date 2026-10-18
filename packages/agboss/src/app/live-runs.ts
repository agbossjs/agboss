import { WorkflowCancelledError } from "../core/errors.js";
import type { RunOptions, AgentExecutionOutput } from "../run/types.js";
import type { TernOutcome } from "../terns/index.js";
import type { ExecutionOptions } from "./types.js";

/** The runs in flight by thread: what `app.cancel(thread)` aborts. */
export class LiveRuns {
  readonly #runs = new Map<string, Set<AbortController>>();
  readonly #inFlight = new Set<Promise<unknown>>();
  /** Set once the app interrupts what still runs at its stop (#265 S51): later runs stop at once. */
  #interrupted: unknown;

  /** Runs `work` with a signal that `abort(thread)` or the caller's own signal aborts. */
  async track<T>(
    thread: string,
    caller: AbortSignal | undefined,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    if (this.#interrupted !== undefined) controller.abort(this.#interrupted);
    const runs = this.#runs.get(thread) ?? new Set<AbortController>();
    runs.add(controller);
    this.#runs.set(thread, runs);
    const running = work(
      caller === undefined ? controller.signal : AbortSignal.any([caller, controller.signal]),
    );
    this.#inFlight.add(running);
    try {
      return await running;
    } finally {
      this.#inFlight.delete(running);
      runs.delete(controller);
      if (runs.size === 0 && this.#runs.get(thread) === runs) this.#runs.delete(thread);
    }
  }

  /** Resolves when every run in flight has finished, paused or failed (graceful shutdown, #261). */
  async settled(): Promise<void> {
    await Promise.allSettled([...this.#inFlight]);
  }

  /**
   * Aborts every run in flight, and every later one, with `reason` (the shutdown timeout passed,
   * #265 S51): each stops without failing, releases its lease and stays `running` for recovery.
   */
  interrupt(reason: unknown): void {
    this.#interrupted ??= reason;
    for (const runs of this.#runs.values()) {
      for (const controller of runs) controller.abort(reason);
    }
  }

  /** Aborts the thread's runs in flight; `false` when none is running. */
  abort(thread: string): boolean {
    const runs = this.#runs.get(thread);
    if (runs === undefined || runs.size === 0) return false;
    for (const controller of runs) {
      controller.abort(new WorkflowCancelledError(`thread "${thread}" was cancelled`));
    }
    return true;
  }
}

/** What `execute` / `resume` hand the run: the call's options with the tracked signal. */
export const runOptionsOf = (
  call: Omit<ExecutionOptions, "thread">,
  signal: AbortSignal,
): RunOptions => ({
  signal,
  executionContext: call.executionContext,
  metadata: call.metadata,
  owner: call.owner,
  configurable: call.configurable,
  ...(call.onStream === undefined ? {} : { onStream: call.onStream }),
});

/** The Tern outcome of a paused run that was cancelled instead of resumed. */
export const cancelledOutcome = (run: AgentExecutionOutput): TernOutcome => ({
  replyWith: "",
  status: "failed",
  stopReason: "the run was cancelled",
  route: run.path,
  steps: [],
  costUsd: run.cost.totalUsd,
});
