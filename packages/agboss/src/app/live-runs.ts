import { ExecutionCancelledError } from "../core/errors.js";
import type { AgentExecutionOptions, AgentExecutionOutput } from "../run/types.js";
import type { TurnOutcome } from "../turns/index.js";
import type { CallOptions } from "./types.js";
import { threadMapKeyOf, type ThreadOfTenant } from "../infrastructure/in-memory-database.js";
import type { ExecutionTree } from "../infrastructure/execution-tree.repository.js";
import type { StepEntries } from "../flow/runtime/step-entries.js";

/** A thread's key in the app (#261): its tenant and its id — the same id in two tenants is two threads. */
export type ThreadKey = ThreadOfTenant;

const keyOf = threadMapKeyOf;

/** A tree's key in the app: its tenant and its root execution (#807: one A2A task). */
const treeKeyOf = (tree: ExecutionTree, threadId: string): string =>
  `${tree.tenantId}\u0000${tree.rootExecutionId}\u0000${threadId}`;

/** What a leg is tracked by: its thread, and its root execution when it moves a tree. */
export type TrackedLeg = ThreadKey & { readonly runId?: string };

/**
 * The runs in flight by thread — what `app.cancel(threadId)` aborts — and by tree, what a cancel
 * of one execution aborts (#807: `cancelExecution`, an A2A task's `CancelTask`).
 */
export class LiveRuns {
  readonly #runs = new Map<string, Set<AbortController>>();
  readonly #byTree = new Map<string, Set<AbortController>>();
  readonly #inFlight = new Set<Promise<unknown>>();
  /** Set once the app interrupts what still runs at its stop (#265 S51): later runs stop at once. */
  #interrupted: unknown;
  readonly #interruption = new AbortController();
  /** Set when the instance starts its stop (#367): aborted at the end of its shutdown timeout. */
  #stopDeadline: AbortSignal | undefined;

  /** Runs `work` with a signal that `abort(thread)` or the caller's own signal aborts. */
  async track<T>(
    thread: TrackedLeg,
    caller: AbortSignal | undefined,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    if (this.#interrupted !== undefined) controller.abort(this.#interrupted);
    const key = keyOf(thread);
    const leave = [entered(this.#runs, key, controller)];
    if (thread.runId !== undefined) {
      const tree = { tenantId: thread.tenantId, rootExecutionId: thread.runId };
      leave.push(entered(this.#byTree, treeKeyOf(tree, thread.threadId), controller));
    }
    const running = work(
      caller === undefined ? controller.signal : AbortSignal.any([caller, controller.signal]),
    );
    this.#inFlight.add(running);
    try {
      return await running;
    } finally {
      this.#inFlight.delete(running);
      for (const left of leave) left();
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
   * `settled()` for the close of the workflow's own app: once the instance is stopping, only up to
   * the end of its shutdown timeout (#923) — a run that waits for a store that never answers is
   * given up there (the instance's stop logs it).
   */
  async settledByStop(): Promise<void> {
    const deadline = this.#stopDeadline;
    if (deadline === undefined) return this.settled();
    await Promise.race([
      this.settled(),
      new Promise<void>((resolve) => {
        if (deadline.aborted) resolve();
        else
          deadline.addEventListener(
            "abort",
            () => {
              resolve();
            },
            { once: true },
          );
      }),
    ]);
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
    if (!this.#interruption.signal.aborted) this.#interruption.abort(reason);
    for (const runs of this.#runs.values()) {
      for (const controller of runs) controller.abort(reason);
    }
  }

  /**
   * Aborted with the stop's reason once the app interrupts what still runs (#265 S51) — never by a
   * cancel: what an automatic undo stops on besides a lost lease (#340 PR 4).
   */
  get interruption(): AbortSignal {
    return this.#interruption.signal;
  }

  /** Aborts the thread's runs in flight; `false` when none is running. */
  abort(thread: ThreadKey): boolean {
    return abortAll(this.#runs.get(keyOf(thread)), thread.threadId);
  }

  /**
   * Aborts the legs of one tree on its thread in flight here (#807) — its thread's other runs go
   * on, and so does a tree of that id on another thread (an id minted twice); `false` when none
   * is running here.
   */
  abortExecution(tree: ExecutionTree, threadId: string): boolean {
    return abortAll(this.#byTree.get(treeKeyOf(tree, threadId)), threadId);
  }
}

/** Adds `controller` under `key`; the call that removes it again. */
function entered(
  index: Map<string, Set<AbortController>>,
  key: string,
  controller: AbortController,
): () => void {
  const runs = index.get(key) ?? new Set<AbortController>();
  runs.add(controller);
  index.set(key, runs);
  return () => {
    runs.delete(controller);
    if (runs.size === 0 && index.get(key) === runs) index.delete(key);
  };
}

/** Aborts each of `runs` as a cancel of the thread; `false` when there is none. */
function abortAll(runs: Set<AbortController> | undefined, threadId: string): boolean {
  if (runs === undefined || runs.size === 0) return false;
  for (const controller of runs) controller.abort(cancelledErrorOf(threadId));
  return true;
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
  new ExecutionCancelledError({ message: `thread "${threadId}" was cancelled` });

/** The reason a cancelled execution's record gives (#807: what reads it back as cancelled). */
export const CANCELLED_STOP_REASON = "the run was cancelled";

/** The Turn outcome of a cancelled execution: the path it took and what it cost. */
export const cancelledRecordOutcome = (route: readonly string[], costUsd: number): TurnOutcome => ({
  replyWith: "",
  status: "failed",
  stopReason: CANCELLED_STOP_REASON,
  route,
  steps: [],
  costUsd,
});

/** The Turn outcome of a paused run that was cancelled instead of resumed. */
export const cancelledOutcome = (run: AgentExecutionOutput): TurnOutcome =>
  cancelledRecordOutcome(run.path, run.cost.totalUsd);
