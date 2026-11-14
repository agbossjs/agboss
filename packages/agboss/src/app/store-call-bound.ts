import type { Class } from "../components/injection.js";
import { StoreOutcomeUnknownError } from "../infrastructure/store-call-timeout.js";
import {
  failure,
  lostOf,
  timedOut,
  type CallFacts,
  type StoreCallParts,
} from "./store-call-outcome.js";
import { limitOf, StoreCallKind } from "./store-call-kind.js";

export type { StoreCallCounter, StoreCallParts } from "./store-call-outcome.js";
export { LONG_CONTRACTS, MAINTENANCE_METHODS } from "./store-call-kind.js";

/**
 * Every store call the framework awaits is bounded (#928): a Proxy over the store the container
 * creates races each call against its bound, on the application's `Clock`. A call that does not
 * answer is of unknown outcome: under a lease the holder hands the tree over (`abandon`), anywhere
 * else the caller gets `StoreCallTimeoutError`. The late answer is dropped.
 */

const targets = new WeakMap<object, object>();

/** The store behind a bounded one; the value itself when it is not. */
export const targetOf = (store: object): object => targets.get(store) ?? store;

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === "object" && value !== null && typeof Reflect.get(value, "then") === "function";

const isAsyncIterable = (value: unknown): value is AsyncIterable<unknown> =>
  typeof value === "object" &&
  value !== null &&
  typeof Reflect.get(value, Symbol.asyncIterator) === "function";

/** `pending` raced against the call's bound and, for a leased call, against its lease's loss. */
function bounded<T>(parts: StoreCallParts, facts: CallFacts, pending: PromiseLike<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const over = new AbortController();
    const lost = facts.lease?.signal;
    const waiting = AbortSignal.any(lost === undefined ? [over.signal] : [over.signal, lost]);
    let isOver = false;
    const end = (): boolean => {
      if (isOver) return false;
      isOver = true;
      over.abort();
      return true;
    };
    pending.then(
      (value) => {
        if (end()) resolve(value);
      },
      (error: unknown) => {
        if (end()) void failure(parts, facts, error).then(reject);
      },
    );
    void parts.clock.sleep(facts.bound, waiting).then(async () => {
      if (!end()) return;
      if (lost?.aborted === true) reject(lostOf(facts, lost.reason));
      else reject(await failure(parts, facts, timedOut(parts, facts)));
    });
  });
}

/**
 * `source`'s `next()` calls, each bounded as the call that made it. When a step gave up, the
 * source is still running it, and an async generator queues `return()` behind a running `next()`:
 * the close is then started without being awaited (a late rejection of it is logged), so the
 * consumer's `for await` ends with the step's error instead of waiting for a step that never answers.
 */
async function* boundedEach<T>(
  parts: StoreCallParts,
  facts: CallFacts,
  source: AsyncIterable<T>,
): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();
  const gaveUp = { isTrue: false };
  try {
    for (;;) {
      let step: IteratorResult<T>;
      try {
        step = await bounded(parts, facts, iterator.next());
      } catch (error) {
        gaveUp.isTrue = true;
        throw error;
      }
      if (step.done === true) return;
      yield step.value;
    }
  } finally {
    if (gaveUp.isTrue) closeDetached(parts, facts, iterator);
    else if (iterator.return !== undefined) await bounded(parts, facts, iterator.return());
  }
}

/** `iterator.return()` started and not awaited; the rejection it may end with later is only logged. */
function closeDetached(parts: StoreCallParts, facts: CallFacts, iterator: AsyncIterator<unknown>) {
  try {
    void Promise.resolve(iterator.return?.()).catch((error: unknown) => {
      const text = error instanceof Error ? error.message : String(error);
      parts.log?.warn(
        "store.call-close-failed",
        `closing the ${facts.store}.${facts.operation} iterator after its bound failed: ${text}`,
        { executionId: facts.lease?.leaseExecutionId, tenantId: facts.lease?.tenantId },
      );
    });
  } catch {
    // a close that throws at once has nothing left to wait for
  }
}

/** The result of one call: a promise or an async iterable bounded, anything else as it is. */
function boundedResult(parts: StoreCallParts, facts: CallFacts, result: unknown): unknown {
  if (isThenable(result)) return bounded(parts, facts, result);
  if (isAsyncIterable(result)) return boundedEach(parts, facts, result);
  return result;
}

/**
 * One call of the store: its result bounded; a synchronous throw of unknown outcome — a method that
 * is not `async` — is a hand-over as a rejection is (a leased call), any other is thrown as it is.
 */
function boundedCall(parts: StoreCallParts, facts: CallFacts, apply: () => unknown): unknown {
  try {
    return boundedResult(parts, facts, apply());
  } catch (error) {
    if (facts.lease === undefined || !(error instanceof StoreOutcomeUnknownError)) throw error;
    return failure(parts, facts, error).then((handedOver) => Promise.reject(handedOver));
  }
}

/** Lifecycle hooks the container calls: never a store call. */
const HOOKS: ReadonlySet<string> = new Set(["onInit", "onStart", "onStop", "onDestroy"]);

/**
 * `store`, an instance of a class of `contract`, with every call bounded. The store's own `this`
 * (its `#private` fields, its `WeakMap`s) is the real instance; the bounded one is never wrapped twice.
 */
export function boundedStoreOf<T extends object>(
  contract: Class,
  store: T,
  parts: StoreCallParts,
): T {
  if (targets.has(store)) return store;
  const proxy = new Proxy(store, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function" || typeof property !== "string") return value;
      if (property === "constructor" || HOOKS.has(property)) return value;
      return (...args: unknown[]): unknown => {
        const limit = limitOf(contract, property);
        const facts = {
          ...limit,
          contract: contract.name,
          store: target.constructor.name,
          operation: property,
        };
        return boundedCall(parts, facts, () => Reflect.apply(value, target, args));
      };
    },
  });
  targets.set(proxy, store);
  return proxy;
}

export { StoreCallKind };
