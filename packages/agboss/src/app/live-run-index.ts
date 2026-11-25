import { cancelledErrorOf } from "./cancelled-run.js";

/** Adds `controller` under `key`; the call that removes it again (exported for its unit test, #1366). */
export function entered(
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

/** Counts `id` under `key`; the call that counts it out again (exported for its unit test, #1366). */
export function counted(
  index: Map<string, Map<string, number>>,
  key: string,
  id: string,
): () => void {
  const ids = index.get(key) ?? new Map<string, number>();
  ids.set(id, (ids.get(id) ?? 0) + 1);
  index.set(key, ids);
  return () => {
    const left = (ids.get(id) ?? 1) - 1;
    if (left > 0) ids.set(id, left);
    else ids.delete(id);
    if (ids.size === 0 && index.get(key) === ids) index.delete(key);
  };
}

/** Aborts each of `runs` as a cancel of the thread; `false` when there is none (exported for its unit test, #1366). */
export function abortAll(runs: Set<AbortController> | undefined, threadId: string): boolean {
  if (runs === undefined || runs.size === 0) return false;
  for (const controller of runs) controller.abort(cancelledErrorOf(threadId));
  return true;
}
