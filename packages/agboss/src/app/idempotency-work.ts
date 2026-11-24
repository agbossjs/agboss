import type { Clock } from "../infrastructure/clock.js";
import type { FencedEffectWork } from "../infrastructure/fenced-effect.repository.js";
import type { Milliseconds } from "../units/index.js";
import type { IdempotencyRunOptions } from "./idempotency-types.js";
/**
 * The work of `Idempotency.runOnce` (#1317): what a transaction handed to it is wrapped in, and what
 * tells an asynchronous work from a synchronous one.
 */

/**
 * `value` behind a revocable proxy (#1317): once revoked — the attempt timed out, or ended — any
 * use of it throws, so a late completion of `execute` finds its transaction dead and writes
 * nothing. Methods keep the real object as their receiver (a native handle needs it).
 */
export function revocable(value: unknown): {
  readonly value: unknown;
  readonly revoke: () => void;
} {
  if (typeof value !== "object" || value === null) return { value, revoke: () => undefined };
  const { proxy, revoke } = Proxy.revocable(value, {
    get(target, property) {
      const member: unknown = Reflect.get(target, property, target);
      return typeof member === "function" ? (member.bind(target) as unknown) : member;
    },
  });
  return { value: proxy, revoke };
}

/** Whether a work's result is a promise (or any thenable): an asynchronous work. */
export const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === "object" &&
  value !== null &&
  "then" in value &&
  typeof value.then === "function";

/**
 * `execute` bounded by `timeout` on the application's clock (#1317): a stalled one rejects with a
 * `TimeoutError`, so its transaction rolls back and is revoked — a late completion writes nothing.
 */
export function boundedWork<TResult, TTransaction>(
  clock: Pick<Clock, "sleep">,
  bound: { readonly name: string; readonly timeout: Milliseconds },
  execute: IdempotencyRunOptions<TResult, never, TTransaction>["execute"],
): FencedEffectWork<unknown, TResult> {
  const { name, timeout } = bound;
  return (transaction) => {
    const guarded = revocable(transaction);
    let work: unknown;
    try {
      // the transaction is the listed store's: `TTransaction` is the component's word for it
      work = execute(guarded.value as TTransaction);
    } catch (error) {
      guarded.revoke();
      throw error;
    }
    // a synchronous work (SQLite's) is returned as it is: a promise would be refused by its store,
    // and nothing synchronous can be bounded by a timer anyway
    if (!isThenable(work)) {
      guarded.revoke();
      return work as never;
    }
    const stop = new AbortController();
    const timer = clock.sleep(timeout, stop.signal).then(() => {
      if (stop.signal.aborted) return new Promise<never>(() => undefined);
      // the transaction is dead from here: a late completion of `execute` can write nothing
      guarded.revoke();
      throw new DOMException(
        `idempotent effect "${name}" passed its timeout of ${String(timeout)} ms: rolled back`,
        "TimeoutError",
      );
    });
    timer.catch(() => undefined);
    return Promise.race([work as Promise<never>, timer]).finally(() => {
      stop.abort();
      guarded.revoke();
    });
  };
}
