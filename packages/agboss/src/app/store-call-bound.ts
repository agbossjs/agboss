import type { Class } from "../components/injection.js";
import type { Clock } from "../infrastructure/clock.js";
import type { FrameworkLog } from "../infrastructure/logger.js";
import {
  StoreCallTimeoutError,
  StoreOutcomeSource,
  StoreOutcomeUnknownError,
} from "../infrastructure/store-call-timeout.js";
import { ExecutionLeaseLostError } from "./lease-lost.js";
import { limitOf, StoreCallKind, type StoreCallLimit } from "./store-call-kind.js";

export { LONG_CONTRACTS, MAINTENANCE_METHODS } from "./store-call-kind.js";

/**
 * Every store call the framework awaits is bounded (#928): a Proxy over the store the container
 * creates races each call against its bound, on the application's `Clock`. A call that does not
 * answer is of unknown outcome: under a lease the holder hands the tree over (`abandon`), anywhere
 * else the caller gets `StoreCallTimeoutError`. The late answer is dropped.
 */

/** Where a call given up at its bound is counted (`agboss.instance.store_calls.timed_out`). */
export interface StoreCallCounter {
  add(count: number, attributes: Record<string, string>): void;
}

/** What the bound reports to: the clock it runs on, and the log and counter once the instance has them. */
export interface StoreCallParts {
  readonly clock: Clock;
  readonly log?: FrameworkLog | undefined;
  /** Counts a timeout: `agboss.instance.store_calls.timed_out`. */
  readonly timedOut?: StoreCallCounter | undefined;
}

/** The facts of one call a bound reports. */
interface CallFacts extends StoreCallLimit {
  readonly contract: string;
  readonly store: string;
  readonly operation: string;
}

const targets = new WeakMap<object, object>();

/** The store behind a bounded one; the value itself when it is not. */
export const targetOf = (store: object): object => targets.get(store) ?? store;

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === "object" && value !== null && typeof Reflect.get(value, "then") === "function";

const isAsyncIterable = (value: unknown): value is AsyncIterable<unknown> =>
  typeof value === "object" &&
  value !== null &&
  typeof Reflect.get(value, Symbol.asyncIterator) === "function";

/** What the holder is told and the log shows when the bound fired. */
function timedOut(parts: StoreCallParts, facts: CallFacts): StoreCallTimeoutError {
  const timeout = facts.bound;
  const { store, operation } = facts;
  const error = new StoreCallTimeoutError({
    store,
    operation,
    timeout,
    source: StoreOutcomeSource.Framework,
  });
  const executionId = facts.lease?.leaseExecutionId;
  const text = `${error.message} (${facts.kind} call; its late answer is dropped)`;
  parts.log?.warn("store.call-timeout", text, { executionId, tenantId: facts.lease?.tenantId });
  const { source } = error;
  parts.timedOut?.add(1, { contract: facts.contract, operation, source, kind: facts.kind });
  return error;
}

/** What a rejection of the store becomes: a hand-over when the call was leased and its outcome is unknown. */
async function failure(facts: CallFacts, error: unknown): Promise<Error> {
  const { lease } = facts;
  if (lease === undefined || !(error instanceof StoreOutcomeUnknownError))
    return error instanceof Error ? error : new Error(String(error), { cause: error });
  await lease.abandon?.(error);
  return new ExecutionLeaseLostError({ rootExecutionId: lease.leaseExecutionId, cause: error });
}

/** The error of a call whose lease was lost while it hung: the lease's own reason. */
const lostOf = (facts: CallFacts, reason: unknown): Error =>
  reason instanceof Error
    ? reason
    : new ExecutionLeaseLostError({ rootExecutionId: facts.lease?.leaseExecutionId ?? "" });

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
        if (end()) void failure(facts, error).then(reject);
      },
    );
    void parts.clock.sleep(facts.bound, waiting).then(async () => {
      if (!end()) return;
      if (lost?.aborted === true) reject(lostOf(facts, lost.reason));
      else reject(await failure(facts, timedOut(parts, facts)));
    });
  });
}

/** `source`'s `next()` calls, each bounded as the call that made it. */
async function* boundedEach<T>(
  parts: StoreCallParts,
  facts: CallFacts,
  source: AsyncIterable<T>,
): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();
  try {
    for (;;) {
      const step = await bounded(parts, facts, iterator.next());
      if (step.done === true) return;
      yield step.value;
    }
  } finally {
    await iterator.return?.();
  }
}

/** The result of one call: a promise or an async iterable bounded, anything else as it is. */
function boundedResult(parts: StoreCallParts, facts: CallFacts, result: unknown): unknown {
  if (isThenable(result)) return bounded(parts, facts, result);
  if (isAsyncIterable(result)) return boundedEach(parts, facts, result);
  return result;
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
        return boundedResult(parts, facts, Reflect.apply(value, target, args));
      };
    },
  });
  targets.set(proxy, store);
  return proxy;
}

export { StoreCallKind };
