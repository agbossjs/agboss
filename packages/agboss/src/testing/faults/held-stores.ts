import { Injectable } from "../../components/decorators.js";
import { depsOf } from "../../components/container/container.js";
import type { Class } from "../../components/injection.js";
import { ChildExecutionQueueRepository } from "../../infrastructure/child-execution-queue.repository.js";
import { ExecutionHistoryRepository } from "../../infrastructure/execution-history.repository.js";
import { ExecutionLeaseRepository } from "../../infrastructure/execution-lease.repository.js";
import { ExecutionTreeRepository } from "../../infrastructure/execution-tree.repository.js";
import { FencedEffectRepository } from "../../infrastructure/fenced-effect.repository.js";
import { OutboundCallRepository } from "../../infrastructure/outbound-call.repository.js";
import { HoldPhase, processHoldPoints, type HoldPoints } from "./hold-points.js";
import {
  monotonicNow,
  OperationPhase,
  type OperationEvent,
  type OperationRecorder,
} from "./operation-history.js";
import {
  CHILD_QUEUE_METHODS,
  HISTORY_METHODS,
  FENCED_EFFECT_METHODS,
  LEASE_METHODS,
  OUTBOUND_CALL_METHODS,
  type StoreMethod,
} from "./store-points.js";
import { StoreOutage } from "./store-outage.js";
import { TREE_METHODS } from "./tree-points.js";

/**
 * `withHoldPoints(Store)` (#484 AC5): any store of the lease, fenced-effect, outbound-call,
 * child-queue, history or tree contract (#607), with the store hold points of `StoreHoldPoint` — a subclass that, around
 * each of the contract's operations, waits at the operation's point before the store is asked and
 * after it answered (when a test armed a hold there), records the operation's invoke and complete
 * in the history, and refuses or hangs while the process's store outage lasts. The store's own
 * code runs as it is: listed in place of the store (`providers: [withHoldPoints(PgLeases), …]`),
 * it injects the same `deps` and declares the same `backend`. A store author writes no seam.
 */

/** Where held stores send their holds, history and outage: the process's own, by default. */
export interface HeldStoreSeam {
  points: HoldPoints;
  recorder: OperationRecorder | undefined;
  /** The process's name in the history (a pod's), and its application instance once known. */
  process: string;
  instanceId: string;
  readonly outage: StoreOutage;
}

/** The seam of this process's held stores (the fault pod sets its recorder and names). */
export const heldStoreSeam: HeldStoreSeam = {
  points: processHoldPoints,
  recorder: undefined,
  process: `process-${String(process.pid)}`,
  instanceId: "",
  outage: new StoreOutage(),
};

/** The contracts with hold points, the methods of each. */
const CONTRACTS: readonly (readonly [Class, Readonly<Record<string, StoreMethod>>])[] = [
  [ExecutionLeaseRepository, LEASE_METHODS],
  [FencedEffectRepository, FENCED_EFFECT_METHODS],
  [OutboundCallRepository, OUTBOUND_CALL_METHODS],
  [ChildExecutionQueueRepository, CHILD_QUEUE_METHODS],
  [ExecutionHistoryRepository, HISTORY_METHODS],
  [ExecutionTreeRepository, TREE_METHODS],
];

/** The methods of the contract `store` implements; `undefined` for another class. */
export const heldMethodsOf = (store: Class): Readonly<Record<string, StoreMethod>> | undefined =>
  CONTRACTS.find(([contract]) =>
    Object.prototype.isPrototypeOf.call(contract.prototype, store.prototype),
  )?.[1];

let operations = 0;

/** Records one event of the operation `id` on the seam's recorder. */
function recorded(
  seam: HeldStoreSeam,
  event: Omit<OperationEvent, "process" | "instanceId" | "at">,
): void {
  const { process, instanceId } = seam;
  seam.recorder?.record({ ...event, process, instanceId, at: monotonicNow() });
}

/** What the history keeps of an error. */
const errorFacts = (error: unknown) => ({
  name: error instanceof Error ? error.name : typeof error,
  message: error instanceof Error ? error.message : String(error),
});

/** One held operation: the outage, the hold before, the store, the record, the hold after. */
async function heldCall(
  method: StoreMethod,
  args: readonly unknown[],
  call: () => Promise<unknown>,
): Promise<unknown> {
  const seam = heldStoreSeam;
  const key = method.keyOf(args);
  await seam.outage.passed(method.point);
  await seam.points.reach(method.point, HoldPhase.Before, key);
  operations += 1;
  const id = `${seam.process}#${String(operations)}`;
  const base = { id, operation: method.point, key };
  recorded(seam, { ...base, phase: OperationPhase.Invoke, input: method.inputOf(args) });
  let result: unknown;
  try {
    result = await call();
  } catch (error) {
    recorded(seam, { ...base, phase: OperationPhase.Complete, error: errorFacts(error) });
    throw error;
  }
  recorded(seam, { ...base, phase: OperationPhase.Complete, output: method.outputOf(result) });
  await seam.points.reach(method.point, HoldPhase.After, method.resultKeyOf?.(result) ?? key);
  return result;
}

/** The method `name` of `store`'s prototype chain. */
function originalOf(store: Class, name: string): (...args: unknown[]) => Promise<unknown> {
  const original: unknown = Reflect.get(store.prototype, name);
  if (typeof original !== "function")
    throw new TypeError(`${store.name} has no method ${name}: it is not a complete store`);
  return original as (...args: unknown[]) => Promise<unknown>;
}

/** A listed store class, extended as the concrete class it is (its type may be the abstract contract). */
const concreteOf = (store: Class): new (...args: unknown[]) => object =>
  store as new (...args: unknown[]) => object;

/** The subclass, typed as the store it extends (same constructor, same statics). */
function sameClass<TStore extends Class>(store: TStore, held: Class): TStore {
  const typed: unknown = held;
  if (!(typeof typed === "function" && typed.prototype instanceof store))
    throw new TypeError(`${held.name} does not extend ${store.name}`);
  return typed as TStore;
}

/**
 * `store` with the hold points of its contract: a subclass of the same `deps` and `backend`,
 * named `Held<Store>`. A class of no held contract is a `TypeError`.
 */
export function withHoldPoints<TStore extends Class>(store: TStore): TStore {
  const methods = heldMethodsOf(store);
  if (methods === undefined)
    throw new TypeError(
      `withHoldPoints(${store.name}): not a lease, fenced-effect, outbound-call, child-queue, history or tree store`,
    );
  // an abstract-typed class is extended as the concrete store it is (a listed provider)
  const Concrete = concreteOf(store);
  const held = class extends Concrete {};
  for (const [name, method] of Object.entries(methods)) {
    const original = originalOf(store, name);
    Object.defineProperty(held.prototype, name, {
      configurable: true,
      writable: true,
      value(this: object, ...args: unknown[]): Promise<unknown> {
        return heldCall(method, args, () => original.apply(this, args));
      },
    });
  }
  Object.defineProperty(held, "name", { value: `Held${store.name}` });
  Injectable({ deps: depsOf(store) as [] })(held);
  return sameClass(store, held);
}
