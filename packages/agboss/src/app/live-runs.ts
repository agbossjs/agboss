import { ExecutionCancelledError } from "../core/errors.js";
import type { AgentExecutionOptions, AgentExecutionOutput } from "../run/types.js";
import type { TernOutcome } from "../terns/index.js";
import type { CallOptions } from "./types.js";
import { threadMapKeyOf, type ThreadOfTenant } from "../infrastructure/thread-map-key.js";
import type { ExecutionTree } from "../infrastructure/execution-tree.repository.js";
import type { StepEntries } from "../flow/runtime/step-entries.js";

/** A thread's key in the app (#261): its tenant and its id — the same id in two tenants is two threads. */
export type ThreadKey = ThreadOfTenant;

const keyOf = threadMapKeyOf;

/** The runs in flight by thread: what `app.cancel(threadId)` aborts. */
export class LiveRuns {
  readonly #runs = new Map<string, Set<AbortController>>();
  readonly #inFlight = new Set<Promise<unknown>>();
  /** Set once the app interrupts what still runs at its stop (#265 S51): later runs stop at once. */
  #interrupted: unknown;
  /** Set when the instance starts its stop (#367): aborted at the end of its shutdown timeout. */
  #stopDeadline: AbortSignal | undefined;

  /** Runs `work` with a signal that `abort(thread)` or the caller's own signal aborts. */
  async track<T>(
    thread: ThreadKey,
    caller: AbortSignal | undefined,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    if (this.#interrupted !== undefined) controller.abort(this.#interrupted);
    const key = keyOf(thread);
    const runs = this.#runs.get(key) ?? new Set<AbortController>();
    runs.add(controller);
    this.#runs.set(key, runs);
    const running = work(
      caller === undefined ? controller.signal : AbortSignal.any([caller, controller.signal]),
    );
    this.#inFlight.add(running);
    try {
      return await running;
    } finally {
      this.#inFlight.delete(running);
      runs.delete(controller);
      if (runs.size === 0 && this.#runs.get(key) === runs) this.#runs.delete(key);
    }
  }

  /**
   * Tracks a tree's move under its lease as in flight until it ended — its lease released too
   * (#367): `settled()` waits for the release, not only for the pass.
   */
  async moving<T>(move: Promise<T>): Promise<T> {
    this.#inFlight.add(move);
    try {
      return await move;
    } finally {
      this.#inFlight.delete(move);
    }
  }

  /**
   * Resolves when every run and move in flight has finished, paused or failed — the ones that began
   * meanwhile too (graceful shutdown, #261).
   */
  async settled(): Promise<void> {
    while (this.#inFlight.size > 0) await Promise.allSettled([...this.#inFlight]);
  }

  /**
   * The instance stops (#367): from now on a tree's lease is released only once the tree's running
   * step bodies returned, or `deadline` (the end of the shutdown timeout) aborted.
   */
  stopBy(deadline: AbortSignal): void {
    this.#stopDeadline ??= deadline;
  }

  /**
   * Before a tree's lease is released (#367): at once while the instance is not stopping; when it
   * is, once the tree's running step bodies returned or its shutdown timeout ended — never before,
   * so no other instance recovers a step whose body still runs here.
   */
  async stepsClosed(tree: ExecutionTree, steps: StepEntries | undefined): Promise<void> {
    const deadline = this.#stopDeadline;
    if (steps === undefined || deadline === undefined) return;
    await steps.closedOf(tree, deadline);
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
  abort(thread: ThreadKey): boolean {
    const runs = this.#runs.get(keyOf(thread));
    if (runs === undefined || runs.size === 0) return false;
    for (const controller of runs) controller.abort(cancelledErrorOf(thread.threadId));
    return true;
  }
}

/** What a leg of a tree is moved with: the call's options, its owner (#261: `ownerId`). */
export interface TreeCall extends CallOptions {
  readonly ownerId?: string | undefined;
}

/** What `execute` / `resume` hand the run: the call's options with the tracked signal. */
export const runOptionsOf = (call: TreeCall, signal: AbortSignal): AgentExecutionOptions => ({
  signal,
  ownerId: call.ownerId,
  configurable: call.configurable,
  ...(call.onStream === undefined ? {} : { onStream: call.onStream }),
});

/** Why a thread's execution stopped when it was cancelled — on its own instance or another (#360). */
export const cancelledErrorOf = (threadId: string): ExecutionCancelledError =>
  new ExecutionCancelledError(`thread "${threadId}" was cancelled`);

/** The Tern outcome of a cancelled execution: the path it took and what it cost. */
export const cancelledRecordOutcome = (route: readonly string[], costUsd: number): TernOutcome => ({
  replyWith: "",
  status: "failed",
  stopReason: "the run was cancelled",
  route,
  steps: [],
  costUsd,
});

/** The Tern outcome of a paused run that was cancelled instead of resumed. */
export const cancelledOutcome = (run: AgentExecutionOutput): TernOutcome =>
  cancelledRecordOutcome(run.path, run.cost.totalUsd);
