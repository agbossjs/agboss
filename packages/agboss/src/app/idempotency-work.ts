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
