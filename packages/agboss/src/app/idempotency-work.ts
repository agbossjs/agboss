import type { Clock } from "../infrastructure/clock.js";
import type { FencedEffectWork } from "../infrastructure/fenced-effect.repository.js";
import type { Milliseconds } from "../units/index.js";
import type { IdempotencyRunOptions } from "./idempotency-types.js";
/**
 * The work of `Idempotency.runOnce` (#1317): what tells an asynchronous work from a synchronous one,
 * and the bound on it. The work is handed no transaction: a store's own writes go through its
 * connection's ambient `requireTransaction()`, which the store closes when the attempt ends or
 * times out — a late completion of `execute` finds it dead and writes nothing.
 */

/** Whether a work's result is a promise (or any thenable): an asynchronous work. */
export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}

/**
 * `execute` bounded by `timeout` on the application's clock (#1317): a stalled one rejects with a
 * `TimeoutError`, so its transaction rolls back and is revoked — a late completion writes nothing.
 */
export function boundedWork<TResult>(
  clock: Pick<Clock, "sleep">,
  bound: { readonly name: string; readonly timeout: Milliseconds },
  execute: IdempotencyRunOptions<TResult>["execute"],
): FencedEffectWork<TResult> {
  const { name, timeout } = bound;
  return () => {
    const work: unknown = execute();
    // a synchronous work is returned as it is: nothing synchronous can be bounded by a timer
    if (!isThenable(work)) return work as never;
    const stop = new AbortController();
    // the race settles before `stop` aborts (below), so a sleep that ends on the abort is read by no one
    const timer = clock.sleep(timeout, stop.signal).then(() => {
      // the store rolls the attempt back and closes its transaction: a late completion writes nothing
      throw new DOMException(
        `idempotent effect "${name}" passed its timeout of ${String(timeout)} ms: rolled back`,
        "TimeoutError",
      );
    });
    return Promise.race([work as Promise<never>, timer]).finally(() => {
      stop.abort();
    });
  };
}
