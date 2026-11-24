import { threadMapKeyOf, type ThreadOfTenant } from "../infrastructure/in-memory-database.js";

/**
 * The request checks of the trees an instance moves, by thread (#1341b): each holder registers its
 * watch's check, so `app.stop` on that instance runs them at once and a local stop reaches its
 * holder now, not at the next lease renewal.
 */
export class RequestChecks {
  readonly #checks = new Map<string, Set<() => Promise<void>>>();

  /** Registers the check of a tree moved here; the call that removes it again. */
  watching(thread: ThreadOfTenant, check: () => Promise<void>): () => void {
    const key = threadMapKeyOf(thread);
    const checks = this.#checks.get(key) ?? new Set<() => Promise<void>>();
    checks.add(check);
    this.#checks.set(key, checks);
    return () => {
      checks.delete(check);
      if (checks.size === 0 && this.#checks.get(key) === checks) this.#checks.delete(key);
    };
  }

  /** Runs the checks of the thread's trees moved here; how many there were. */
  async checked(thread: ThreadOfTenant): Promise<number> {
    const checks = [...(this.#checks.get(threadMapKeyOf(thread)) ?? [])];
    for (const check of checks) await check();
    return checks.length;
  }
}

const byApp = new WeakMap<object, RequestChecks>();

/** The checks of the app whose runs are `live` (one per `LiveRuns`). */
export function requestChecksOf(live: object): RequestChecks {
  const found = byApp.get(live) ?? new RequestChecks();
  byApp.set(live, found);
  return found;
}
