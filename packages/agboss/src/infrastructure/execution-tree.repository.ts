import { Injectable } from "../components/decorators.js";
import { IN_MEMORY_DATABASE } from "./in-memory-database.js";
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

/**
 * Infrastructure (#265): the shared state of one request — keys under its root execution, visible
 * to the whole tree of executions at any depth and on any instance, invisible to other requests,
 * removed when the tree finishes, fails or is cancelled (a pause keeps them). Every call names its
 * tree (`saveIfAbsentInTree(tree, …)`, `findByIdInTree(tree, …)`: #1321 removed the unscoped ones, which
 * read the tree from the running execution). Listed only in `@Application({ providers })`; the built-in
 * default is in memory. Your own `extends ExecutionTreeRepository` and implements the three tree-scoped
 * methods.
 */
export abstract class ExecutionTreeRepository {
  /**
   * Whether the store answers (#300): resolves when it is reachable, rejects with why not. One fast
   * round trip (`SELECT 1`, a `PING`), never a scan — `app.checkReadiness()` calls it under a
   * timeout of its own.
   */
  abstract ping(): Promise<void>;
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
