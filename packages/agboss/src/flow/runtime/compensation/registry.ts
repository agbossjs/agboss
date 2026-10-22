import type { ExecutionTree } from "../../../infrastructure/execution-tree.repository.js";
import type { Milliseconds } from "../../../units/index.js";
import type { CompensationEntry } from "../../compensation.js";

/**
 * The undoable actions of an application instance's trees, in process (#340 S2): every entry the
 * `compensations` channel gets is mirrored here the moment its step writes it — before LangGraph
 * checkpoints it, so an unwind of a pass that stopped before the write still sees it — and the
 * order they succeeded in (`sequence`) is counted per tree across parallel branches. Forgotten
 * when the tree's pass ends; the checkpoint is what outlives it.
 */
export class CompensationRegistry {
  readonly #trees = new Map<string, Map<string, CompensationEntry>>();
  readonly #sequences = new Map<string, number>();

  /** The entries written: each replaces the tree's entry with the same key. */
  write(tree: ExecutionTree, entries: readonly CompensationEntry[]): void {
    const key = keyOf(tree);
    const known = this.#trees.get(key) ?? new Map<string, CompensationEntry>();
    for (const entry of entries) known.set(entry.key, entry);
    this.#trees.set(key, known);
  }

  /** The tree's entries that `matches` keeps, in the order they were first written. */
  entriesOf(
    tree: ExecutionTree,
    matches: (entry: CompensationEntry) => boolean,
  ): readonly CompensationEntry[] {
    return [...(this.#trees.get(keyOf(tree))?.values() ?? [])].filter(matches);
  }

  /** The next place in the tree's order: after `floor` (the newest its state knows) and every one given. */
  nextSequence(tree: ExecutionTree, floor: number): number {
    const key = keyOf(tree);
    const next = Math.max(this.#sequences.get(key) ?? 0, floor) + 1;
    this.#sequences.set(key, next);
    return next;
  }

  /** The tree's pass ended: its entries live on in its checkpoint only. */
  forget(tree: ExecutionTree): void {
    const key = keyOf(tree);
    this.#trees.delete(key);
    this.#sequences.delete(key);
  }
}

const keyOf = (tree: ExecutionTree): string => `${tree.tenantId}\u0000${tree.rootExecutionId}`;

/** What an application instance gives its graphs for compensation (#340). */
export interface CompensationParts {
  /** `@Application({ compensationTimeout })`: each automatic undo's bound, and the wait before. */
  readonly timeout: Milliseconds;
  readonly registry: CompensationRegistry;
}
