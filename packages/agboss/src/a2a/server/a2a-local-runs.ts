import type { A2ATaskKey } from "../../infrastructure/a2a-task.repository.js";
import type { Clock } from "../../infrastructure/clock.js";
import type { ExecutionStreamEvent } from "../../run/types.js";
import { seconds } from "../../units/index.js";
import { onTaskChange } from "../tasks/task-changes.js";

/**
 * The task runs a listener started in this process (#808): a start or a resume, detached from the
 * request that asked for it — a caller that disconnects never stops it (#806 item 1) —, with its
 * stream events for this process's subscribers and its end, which a waiter of the task reads at
 * once. A run on another instance is read from the task store only.
 */

/** How often a waiter reads a task again when nothing in this process woke it. */
export const TASK_POLL = seconds(1);

/** One run of a task in this process. */
interface LocalRun {
  readonly settled: Promise<void>;
  readonly listeners: Set<(event: ExecutionStreamEvent) => void>;
}

const keyOf = (key: A2ATaskKey): string => `${key.tenantId}\u0000${key.taskId}`;

/** The runs of one listener's tasks in this process. */
export class LocalRuns {
  readonly #runs = new Map<string, LocalRun>();

  /**
   * Starts a task's run: `run` gets the stream callback to pass on; its end — a result or an error,
   * the task's state says which — is kept only as "settled". Never rejects.
   */
  start(
    key: A2ATaskKey,
    run: (onStream: (event: ExecutionStreamEvent) => void) => Promise<unknown>,
  ): Promise<void> {
    const listeners = new Set<(event: ExecutionStreamEvent) => void>();
    const onStream = (event: ExecutionStreamEvent): void => {
      for (const listener of listeners) listener(event);
    };
    const text = keyOf(key);
    // the run's own error is its task's status (the projection writes it): nothing to rethrow here
    const settled = run(onStream).then(
      () => undefined,
      () => undefined,
    );
    const entry = { settled, listeners };
    this.#runs.set(text, entry);
    void settled.then(() => {
      if (this.#runs.get(text) === entry) this.#runs.delete(text);
    });
    return settled;
  }

  /** The end of the task's run in this process, if one runs here. */
  settledOf(key: A2ATaskKey): Promise<void> | undefined {
    return this.#runs.get(keyOf(key))?.settled;
  }

  /** Hears the stream events of the task's run here (a run started later is not heard). */
  listen(key: A2ATaskKey, listener: (event: ExecutionStreamEvent) => void): () => void {
    const run = this.#runs.get(keyOf(key));
    run?.listeners.add(listener);
    return () => run?.listeners.delete(listener);
  }
}

/**
 * Resolves at the task's next change in this process, at the end of its run here, after
 * `TASK_POLL` on the clock, or when `signal` aborts — whichever comes first. Never rejects.
 */
export async function nextChange(
  parts: { readonly clock: Pick<Clock, "sleep">; readonly runs: LocalRuns },
  key: A2ATaskKey,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  const stop = new AbortController();
  const onAbort = (): void => {
    stop.abort();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  let unsubscribe: () => void = () => undefined;
  const changed = new Promise<void>((resolve) => {
    unsubscribe = onTaskChange(key, resolve);
  });
  try {
    await Promise.race([
      changed,
      parts.runs.settledOf(key) ?? new Promise<never>(() => undefined),
      // a clock of the host's own may reject a sleep its signal stopped: a wake-up all the same
      parts.clock.sleep(TASK_POLL, stop.signal).catch(() => undefined),
    ]);
  } finally {
    unsubscribe();
    stop.abort();
    signal.removeEventListener("abort", onAbort);
  }
}
