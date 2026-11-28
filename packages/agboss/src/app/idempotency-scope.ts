import { AsyncLocalStorage } from "node:async_hooks";
import { IdempotencyError } from "../core/error-families/effect-errors.js";

/**
 * Where an `Idempotency.runOnce` is running (#1317c): its `execute` holds the store's transaction —
 * a lock on the database — so nothing in it may reach another system, count a spend or start another
 * effect: the transaction would be held across network I/O, and a store may run `execute` again
 * (MongoDB's driver retries a transient transaction error, #730), repeating a side effect. The scope
 * lives in the async context `execute` runs in and is closed once it ends, so a promise `execute`
 * left running finds it closed — it is no longer in the transaction.
 */

/** One running `runOnce`. */
interface RunOnceScope {
  readonly name: string;
  isClosed: boolean;
}

const scopes = new AsyncLocalStorage<RunOnceScope | undefined>();

/** The name of the `runOnce` the caller is inside of, or `undefined` outside any (a closed one is none). */
export const runOnceNameOf = (): string | undefined => {
  const scope = scopes.getStore();
  return scope === undefined || scope.isClosed ? undefined : scope.name;
};

/** `work` as the body of the `runOnce` `name`: the scope is open while it runs, closed once it settled. */
export function inRunOnce<TWork extends () => unknown>(
  name: string,
  work: TWork,
): ReturnType<TWork> {
  const scope: RunOnceScope = { name, isClosed: false };
  const close = (): void => {
    scope.isClosed = true;
  };
  let result: unknown;
  try {
    result = scopes.run(scope, work);
  } catch (error) {
    close();
    throw error;
  }
  // a synchronous work (SQLite's) is returned as it is: a store refuses a promise from it
  if (!(result instanceof Promise)) {
    close();
    return result as ReturnType<TWork>;
  }
  return result.finally(close) as ReturnType<TWork>;
}

/** `work` with no `runOnce` around it: a branch or a child launched from inside one is not in its transaction. */
export function outsideRunOnce<TValue>(work: () => TValue): TValue {
  return scopes.run(undefined, work);
}

/** `IdempotencyError.NestedRunOnce` when called inside a `runOnce`: one transaction at a time. */
export function assertNotNested(name: string): void {
  const outer = runOnceNameOf();
  if (outer !== undefined)
    throw new IdempotencyError.NestedRunOnce({
      message: `Idempotency.runOnce "${name}" was called inside runOnce "${outer}": an effect's write is one transaction, and a second one inside it would wait for the first, or exhaust a single-connection pool — nothing ran`,
    });
}

/**
 * `IdempotencyError.ExternalCallInTransaction` when `what` (a call to another system, a spend, a
 * `sendOnce`) is made inside a `runOnce`: do it before or after it, `sendOnce` for a call that must
 * happen once.
 */
export function assertOutsideRunOnce(what: string): void {
  const outer = runOnceNameOf();
  if (outer !== undefined)
    throw new IdempotencyError.ExternalCallInTransaction({
      message: `${what} inside runOnce "${outer}": the effect's transaction is open — never hold a database lock across a call to another system, and a store may run the effect again (MongoDB retries a transient transaction error) and repeat what it did: do it before or after runOnce`,
    });
}
