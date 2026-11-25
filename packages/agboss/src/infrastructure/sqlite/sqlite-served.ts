import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Where a statement of a SQLite repository may run (#1317, bug hunt 2026-11-25): only inside a
 * served group — the synchronous work the connection's gate runs (`connection.serve`, or a gated
 * method's synchronous part). The gate covers a method only up to its first `await`: a statement
 * after it would run while another `runOnce` holds the file, and outside the clean attempt that
 * retries a lock wait. So an operation's continuation is marked, and a statement in it that is not
 * served again fails at once, every time — never only when a hold happens to open in the gap.
 */

/** The operation a continuation belongs to: the connection whose gated method it is. */
interface Operation {
  readonly owner: object;
}

/** The async context of the gated operations, one for every file. */
const operations = new AsyncLocalStorage<Operation>();

/** `work` (a gated method's call) as an operation of `owner`: its continuations are marked. */
export function inSqliteOperation<TValue>(owner: object, work: () => TValue): TValue {
  return operations.run({ owner }, work);
}

/** The served groups of one connection: how deep the synchronous gated work running now is. */
export class ServedGroups {
  readonly #owner: object;
  #depth = 0;

  constructor(owner: object) {
    this.#owner = owner;
  }

  /** `work` (synchronous statements) as one served group. */
  served<TValue>(work: () => TValue): TValue {
    this.#depth += 1;
    try {
      return work();
    } finally {
      this.#depth -= 1;
    }
  }

  /**
   * Refuses a statement of an operation of this connection that runs after one of its `await`s,
   * outside `connection.serve`: it slipped past the file's queue.
   */
  assertServed(): void {
    if (this.#depth > 0 || operations.getStore()?.owner !== this.#owner) return;
    throw new Error(
      "unreachable: a statement of a SQLite repository operation ran after an await of it, outside connection.serve — the gate covers an operation only up to its first await, so every group of statements after one goes through connection.serve(() => …)",
    );
  }
}
