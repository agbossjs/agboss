import type { A2ATaskKey } from "../../infrastructure/a2a-task.repository.js";

/**
 * In-process wake-ups of a task's waiters (#808, design §4.1.3 step 8): every write of a task's
 * status in this process — the projection's, a read repair's, a cancel's — says so here, and a
 * blocking `SendMessage` or a stream waiting on that task reads it again at once. A hint only: a
 * write on another instance wakes nobody here, so waiters also read again on the `Clock`.
 */

const waiters = new Map<string, Set<() => void>>();

const keyOf = (key: A2ATaskKey): string => `${key.tenantId}\u0000${key.taskId}`;

/** Wakes this process's waiters of a task. */
export function taskChanged(key: A2ATaskKey): void {
  for (const wake of [...(waiters.get(keyOf(key)) ?? [])]) wake();
}

/** Calls `wake` on each change of a task in this process, until the returned function is called. */
export function onTaskChange(key: A2ATaskKey, wake: () => void): () => void {
  const text = keyOf(key);
  const set = waiters.get(text) ?? new Set<() => void>();
  waiters.set(text, set);
  set.add(wake);
  return () => {
    set.delete(wake);
    if (set.size === 0) waiters.delete(text);
  };
}

/** How many tasks have waiters in this process: none left behind once each stopped waiting. */
export const waitedTaskCount = (): number => waiters.size;

/**
 * A reader's standing subscription to one task's changes (#1140). A notice sent while the reader is
 * busy — writing a frame, reading the store — reaches nobody that waits at that moment; the watch
 * keeps it: `takeChanged()` says whether one came since the last take, so the reader reads the task
 * again instead of waiting for the next notice or poll. Take before reading, and no notice is lost:
 * one that comes after the take is the next take's.
 */
export class TaskWatch {
  #isChanged = true; // a change between the reader's own read of the task and this subscription is one too
  readonly #stop: () => void;

  constructor(key: A2ATaskKey) {
    this.#stop = onTaskChange(key, () => {
      this.#isChanged = true;
    });
  }

  /** Whether the task changed since the last take (the first take: since the reader read it); clears the mark. */
  takeChanged(): boolean {
    const was = this.#isChanged;
    this.#isChanged = false;
    return was;
  }

  /** Stops listening. */
  close(): void {
    this.#stop();
  }
}
