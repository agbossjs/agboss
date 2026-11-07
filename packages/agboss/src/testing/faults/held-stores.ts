import { Injectable } from "../../components/decorators.js";
import { depsOf } from "../../components/container/container.js";
import type { Class } from "../../components/injection.js";
import { ChildExecutionQueueRepository } from "../../infrastructure/child-execution-queue.repository.js";
import { ExecutionHistoryRepository } from "../../infrastructure/execution-history.repository.js";
import { ExecutionLeaseRepository } from "../../infrastructure/execution-lease.repository.js";
import { ExecutionTreeRepository } from "../../infrastructure/execution-tree.repository.js";
import { FencedEffectRepository } from "../../infrastructure/fenced-effect.repository.js";
import { OutboundCallRepository } from "../../infrastructure/outbound-call.repository.js";
import {
  HoldPhase,
  processHoldPoints,
  type HeldOperation,
  type HoldPoints,
} from "./hold-points.js";
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
 * it injects the same `deps` and declares the same `backend`. A store author writes no hook of
 * their own: `reportHeldOperations` hears what the held stores do.
 */

/**
 * Where this process's held stores send their holds, history and outage (internal): the process's
 * hold points, the recorders of its history, its name and instance in the history, its outage.
 */
export interface HeldStoreState {
  points: HoldPoints;
  readonly recorders: Set<OperationRecorder>;
  /** The process's name in the history (a pod's), and its application instance once known. */
  process: string;
  instanceId: string;
  readonly outage: StoreOutage;
}

/** The state of this process's held stores (the fault pod adds its recorder and names it). */
export const heldStoreState: HeldStoreState = {
  points: processHoldPoints,
  recorders: new Set(),
  process: `process-${String(process.pid)}`,
  instanceId: "",
  outage: new StoreOutage(),
};

/** What a store's own process test hears of this process's held stores (#831). */
export interface HeldOperationsReport {
  /** The instance the history names this process's operations by (its application's). */
  readonly instanceId?: string;
  /** Every held store operation's invoke and complete, as the history records it. */
  readonly onOperation?: (event: OperationEvent) => void;
  /** Every operation held at one of `processHoldPoints`' armed points. */
  readonly onHeld?: (operation: HeldOperation) => void;
}

const REPORT_KEYS: ReadonlySet<string> = new Set(["instanceId", "onOperation", "onHeld"]);

/** The instance id a live report names the history by, and that report (one at a time). */
let naming: string | undefined;
let namer: symbol | undefined;

/**
 * Reports this process's held operations (#831, in place of a mutable global): from now on
 * `onOperation` hears every operation of a `withHoldPoints` store and `onHeld` every hold, and the
 * history names them by `instanceId`. The returned function undoes it — both listeners removed,
 * the instance id given back as it was.
 */
export function reportHeldOperations(report: HeldOperationsReport): () => void {
  const unknown = Object.keys(report).filter((key) => !REPORT_KEYS.has(key));
  if (unknown.length > 0)
    throw new TypeError(
      `reportHeldOperations: ${unknown.join(", ")} — it takes instanceId, onOperation and onHeld`,
    );
  if (report.onOperation === undefined && report.onHeld === undefined)
    throw new TypeError(
      "reportHeldOperations: give onOperation, onHeld or both — it would hear nothing",
    );
  if (report.instanceId !== undefined && naming !== undefined)
    throw new TypeError(
      `reportHeldOperations: the history is named by instance ${naming} already — undo that report first`,
    );
  const before = heldStoreState.instanceId;
  const token = Symbol("report");
  if (report.instanceId !== undefined) {
    heldStoreState.instanceId = report.instanceId;
    naming = report.instanceId;
    namer = token;
  }
  const { onOperation, onHeld } = report;
  const recorder: OperationRecorder | undefined =
    onOperation === undefined ? undefined : { record: onOperation };
  if (recorder !== undefined) heldStoreState.recorders.add(recorder);
  const stopHeld = onHeld === undefined ? undefined : heldStoreState.points.onHeld(onHeld);
  let isUndone = false;
  return () => {
    if (isUndone) return;
    isUndone = true;
    if (recorder !== undefined) heldStoreState.recorders.delete(recorder);
    stopHeld?.();
    if (namer === token) {
      heldStoreState.instanceId = before;
      naming = undefined;
      namer = undefined;
    }
  };
}

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

/** Records one event of the operation `id` on every recorder of the state. */
function recorded(
  state: HeldStoreState,
  event: Omit<OperationEvent, "process" | "instanceId" | "at">,
): void {
  const { process, instanceId } = state;
  const full = { ...event, process, instanceId, at: monotonicNow() };
  for (const recorder of [...state.recorders])
    heardApart(() => {
      recorder.record(full);
    });
}

/**
 * Runs a listener of the held stores apart from the store call (#831): what it throws — a failed
 * `expect` in a test's `onOperation` — never becomes the store's answer, which the framework would
 * read as a store error (a retry, an ambiguous answer, a hand-over) and absorb; it is thrown again
 * on its own, an unhandled error the test run reports.
 */
export function heardApart(listen: () => void): void {
  try {
    listen();
  } catch (error) {
    queueMicrotask(() => {
      throw error;
    });
  }
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
  const state = heldStoreState;
  const key = method.keyOf(args);
  await state.outage.passed(method.point);
  await state.points.reach(method.point, HoldPhase.Before, key);
  operations += 1;
  const id = `${state.process}#${String(operations)}`;
  const base = { id, operation: method.point, key };
  recorded(state, { ...base, phase: OperationPhase.Invoke, input: method.inputOf(args) });
  let result: unknown;
  try {
    result = await call();
  } catch (error) {
    recorded(state, { ...base, phase: OperationPhase.Complete, error: errorFacts(error) });
    throw error;
  }
  recorded(state, { ...base, phase: OperationPhase.Complete, output: method.outputOf(result) });
  await state.points.reach(method.point, HoldPhase.After, method.resultKeyOf?.(result) ?? key);
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
