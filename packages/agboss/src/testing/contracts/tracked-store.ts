import type { VirtualClock } from "../clock.js";

/**
 * A store of a contract target whose calls the case's clock waits for (#511): a networked store's
 * round trip does not finish in the one turn of the event loop `advance` gives the work it wakes,
 * so each call that returns a promise is `track`ed — the framework's lease holder renewing through
 * the store included. Nothing of the store changes: the call runs on the store itself.
 */

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === "object" &&
  value !== null &&
  "then" in value &&
  typeof value.then === "function";

/** `store` with every call that returns a promise tracked on `clock`. */
function trackedObject<TStore extends object>(store: TStore, clock: VirtualClock): TStore {
  return new Proxy(store, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      // the class itself, with its statics (`backend`, #526): never a call to track
      if (typeof value !== "function" || property === "constructor") return value;
      return (...args: unknown[]): unknown => {
        const result: unknown = Reflect.apply(value, target, args);
        return isThenable(result) ? clock.track(Promise.resolve(result)) : result;
      };
    },
  });
}

/**
 * `store` tracked on `clock` — or, for a target that builds a group of stores (a plain object, as
 * the fenced effect's `{ effects, leases }`), each store of the group.
 */
export function trackedStore<TStore>(store: TStore, clock: VirtualClock): TStore {
  if (typeof store !== "object" || store === null) return store;
  if (Object.getPrototypeOf(store) !== Object.prototype) return trackedObject(store, clock);
  const group: Record<string, unknown> = {};
  for (const [name, part] of Object.entries(store)) {
    group[name] = typeof part === "object" && part !== null ? trackedObject(part, clock) : part;
  }
  // the same keys as `store`, each part the same store, tracked
  return group as TStore;
}
