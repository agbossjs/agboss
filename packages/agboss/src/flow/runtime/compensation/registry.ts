import type { ExecutionTree } from "../../../infrastructure/execution-tree.repository.js";
import type { FrameworkLog } from "../../../infrastructure/logger.js";
import type { Milliseconds } from "../../../units/index.js";
import { CompensationEntryStatus, type CompensationEntry } from "../../compensation.js";

/**
 * The undoable actions of an application instance's trees, in process (#340 S2): every entry the
 * `compensations` channel gets is mirrored here the moment its step writes it — before LangGraph
 * checkpoints it, so an unwind of a pass that stopped before the write still sees it — and the
 * order they succeeded in (`sequence`) is counted per tree across parallel branches. Forgotten
 * when the tree's pass ends; the checkpoint is what outlives it.
 *
 * An execution whose automatic unwind ended is sealed (#340 S3 Q-B): an undoable action of it that
 * succeeds afterwards — its body ignored the abort and returned late — is not kept but handed to
 * the seal, which undoes it at once, in process. A seal outlives the tree's pass: it is lifted by
 * its unwind once the execution's last running body returned.
 */

/** Undoes an entry an unwind's seal caught: it opened after the unwind ended. */
export type LateUndo = (entry: CompensationEntry) => void;

/** An ended unwind: which entries it covers and what undoes a late one. */
interface Seal {
  readonly covers: (entry: CompensationEntry) => boolean;
  readonly undo: LateUndo;
}

export class CompensationRegistry {
  readonly #trees = new Map<string, Map<string, CompensationEntry>>();
  readonly #sequences = new Map<string, number>();
  readonly #seals = new Map<string, Set<Seal>>();

  /**
   * The entries written: each replaces the tree's entry with the same key — except an open one a
   * seal covers, which goes to its seal's undo instead.
   */
  write(tree: ExecutionTree, entries: readonly CompensationEntry[]): void {
    const key = keyOf(tree);
    const late: [Seal, CompensationEntry][] = [];
    const kept: CompensationEntry[] = [];
    for (const entry of entries) {
      const seal = this.#sealOf(key, entry);
      if (seal === undefined) kept.push(entry);
      else late.push([seal, entry]);
    }
    if (kept.length > 0) {
      const known = this.#trees.get(key) ?? new Map<string, CompensationEntry>();
      for (const entry of kept) known.set(entry.key, entry);
      this.#trees.set(key, known);
    }
    for (const [seal, entry] of late) seal.undo(entry);
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

  /**
   * An unwind of the entries `covers` keeps ended: a later open one goes to `undo`. Returns the
   * lift — called once the executions it covers have no running body left.
   */
  seal(tree: ExecutionTree, covers: Seal["covers"], undo: LateUndo): () => void {
    const key = keyOf(tree);
    const seal: Seal = { covers, undo };
    const seals = this.#seals.get(key) ?? new Set<Seal>();
    seals.add(seal);
    this.#seals.set(key, seals);
    return (): void => {
      seals.delete(seal);
      if (seals.size === 0 && this.#seals.get(key) === seals) this.#seals.delete(key);
    };
  }

  /** The tree's pass ended: its entries live on in its checkpoint only (its seals stay). */
  forget(tree: ExecutionTree): void {
    const key = keyOf(tree);
    this.#trees.delete(key);
    this.#sequences.delete(key);
  }

  #sealOf(key: string, entry: CompensationEntry): Seal | undefined {
    if (entry.status !== CompensationEntryStatus.Open) return undefined;
    return [...(this.#seals.get(key) ?? [])].find((seal) => seal.covers(entry));
  }
}

const keyOf = (tree: ExecutionTree): string => `${tree.tenantId}\u0000${tree.rootExecutionId}`;

/** What an application instance gives its graphs for compensation (#340). */
export interface CompensationParts {
  /** `@Application({ compensationTimeout })`: each automatic undo's bound, and the wait before. */
  readonly timeout: Milliseconds;
  readonly registry: CompensationRegistry;
  /** Where an unwind reports what it could not do (a body still running, a late undo that failed). */
  readonly log?: FrameworkLog | undefined;
}
