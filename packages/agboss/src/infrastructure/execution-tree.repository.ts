import { Injectable } from "../components/decorators.js";
import { currentFrame, rootFactsOf } from "../flow/context/frame.js";
import { ExecutionContextUnavailableError } from "../flow/context/errors.js";
import { IN_MEMORY_DATABASE } from "./instance-tokens.js";
import { treeKeyOf, type InMemoryDatabase } from "./in-memory-database.js";

/** A value kept under a key of an execution tree: plain JSON, so any store can keep it. */
export type ExecutionTreeValue =
  | string
  | number
  | boolean
  | null
  | readonly ExecutionTreeValue[]
  | { readonly [field: string]: ExecutionTreeValue };

/** The execution tree a key lives in: its tenant and its root execution. */
export interface ExecutionTree {
  /** The tenant of the request (`"default"` when it names none, #261). */
  readonly tenantId: string;
  /** `executionContext.root.executionId` of the request. */
  readonly rootExecutionId: string;
}

/** The tree of the execution the caller runs in; outside one, `ExecutionContextUnavailableError`. */
function currentTree(field: string): ExecutionTree {
  const frame = currentFrame();
  if (frame === undefined || frame.isClosed()) {
    throw ExecutionContextUnavailableError.outside({
      consumer: `ExecutionTreeRepository.${field}`,
      field: "executionContext.root",
    });
  }
  // a child's tree is its root's (#263): every execution of the request shares the keys
  const { tenant } = frame.execution;
  return { tenantId: tenant.tenantId, rootExecutionId: rootFactsOf(frame.execution).executionId };
}

/**
 * Infrastructure (#265): the shared state of one request — keys under its root execution, visible
 * to the whole tree of executions at any depth and on any instance, invisible to other requests,
 * removed when the tree finishes, fails or is cancelled (a pause keeps them). Inject it
 * (`deps: [ExecutionTreeRepository]`) and call `saveIfAbsent` / `findById` inside an execution.
 * Listed only in `@Application({ providers })`; the built-in default is in memory. Your own
 * `extends ExecutionTreeRepository` and implements the three tree-scoped methods.
 */
export abstract class ExecutionTreeRepository {
  /**
   * Whether the store answers (#300): resolves when it is reachable, rejects with why not. One fast
   * round trip (`SELECT 1`, a `PING`), never a scan — `app.checkReadiness()` calls it under a
   * timeout of its own.
   */
  abstract ping(): Promise<void>;
  /** Saves `value` under `key` of the current tree when the key is absent; `true` when this call saved it. */
  saveIfAbsent(key: string, value: ExecutionTreeValue): Promise<boolean> {
    return this.saveIfAbsentInTree(currentTree("saveIfAbsent"), key, value);
  }

  /** The value under `key` of the current tree; `undefined` when absent. */
  findById(key: string): Promise<ExecutionTreeValue | undefined> {
    return this.findByIdInTree(currentTree("findById"), key);
  }

  /** Atomic: of two concurrent calls with one key, exactly one gets `true`. */
  abstract saveIfAbsentInTree(
    tree: ExecutionTree,
    key: string,
    value: ExecutionTreeValue,
  ): Promise<boolean>;

  /** The value under `key` of `tree`; `undefined` when absent. */
  abstract findByIdInTree(
    tree: ExecutionTree,
    key: string,
  ): Promise<ExecutionTreeValue | undefined>;

  /** Removes every key of the tree (the framework calls it when the tree ends). */
  abstract deleteAllInTree(tree: ExecutionTree): Promise<void>;
}

/**
 * The built-in default: the keys in this instance's memory, a copy of each value (as a networked
 * store gives); every operation is one synchronous step, so it is atomic.
 */
@Injectable({ deps: [IN_MEMORY_DATABASE] })
export class InMemoryExecutionTreeRepository extends ExecutionTreeRepository {
  constructor(private readonly database: InMemoryDatabase) {
    super();
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }

  saveIfAbsentInTree(
    tree: ExecutionTree,
    key: string,
    value: ExecutionTreeValue,
  ): Promise<boolean> {
    const treeKey = treeKeyOf(tree.tenantId, tree.rootExecutionId);
    const keys = this.database.executionTrees.get(treeKey) ?? new Map<string, ExecutionTreeValue>();
    if (keys.has(key)) return Promise.resolve(false);
    keys.set(key, structuredClone(value));
    this.database.executionTrees.set(treeKey, keys);
    return Promise.resolve(true);
  }

  findByIdInTree(tree: ExecutionTree, key: string): Promise<ExecutionTreeValue | undefined> {
    const keys = this.database.executionTrees.get(treeKeyOf(tree.tenantId, tree.rootExecutionId));
    const value = keys?.get(key);
    return Promise.resolve(value === undefined ? undefined : structuredClone(value));
  }

  deleteAllInTree(tree: ExecutionTree): Promise<void> {
    this.database.executionTrees.delete(treeKeyOf(tree.tenantId, tree.rootExecutionId));
    return Promise.resolve();
  }
}
