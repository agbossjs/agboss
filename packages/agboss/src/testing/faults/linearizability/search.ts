import { EMPTY_FENCING_STATE, type FencingState } from "../../contracts/models/lease-model.js";
import { applied, objectsOf } from "./apply.js";
import { UNKNOWN, type CheckedOperation } from "./operations.js";

/**
 * The search of a linearization (#533 item 5, Wing & Gong with Porcupine's memo): operations that
 * touch no common object are checked apart (a lease's tree, its scope, a call's identity); within
 * one part, the next operation taken is one invoked before every operation still to take completed,
 * at an instant within its span and not before the last one taken — the earliest such instant, or
 * the latest when the earliest gives another answer than the store's (a lease is live, then not:
 * one of the two gives each answer the store could have; a lease's spans are milliseconds, its
 * length 30 s, so the instant chosen moves no later expiry across another operation).
 * An operation whose answer nobody saw may also never have taken effect. A state already reached
 * with the same operations taken and the same last instant is not searched again.
 */

/** A part of a history that is not linearizable: its operations, and how far a linearization got. */
export interface NotLinearizable {
  readonly operations: readonly CheckedOperation[];
  /** The longest prefix the search found, in its order. */
  readonly longest: readonly CheckedOperation[];
  /** The operations no instant could take next after that prefix. */
  readonly stuck: readonly CheckedOperation[];
}

/** The parts of `operations`: the groups linked by a common object. */
export function partsOf(operations: readonly CheckedOperation[]): CheckedOperation[][] {
  const parent = new Map<string, string>();
  const root = (object: string): string => {
    let at = object;
    while (parent.get(at) !== undefined && parent.get(at) !== at) at = parent.get(at) ?? at;
    return at;
  };
  for (const operation of operations) {
    const [first, ...rest] = objectsOf(operation);
    if (first === undefined) continue;
    if (!parent.has(first)) parent.set(first, first);
    for (const other of rest) {
      if (!parent.has(other)) parent.set(other, other);
      parent.set(root(other), root(first));
    }
  }
  const parts = new Map<string, CheckedOperation[]>();
  for (const operation of operations) {
    const key = root(objectsOf(operation)[0] ?? "");
    parts.set(key, [...(parts.get(key) ?? []), operation]);
  }
  return [...parts.values()];
}

/** What the search carries down. */
interface SearchState {
  readonly taken: readonly boolean[];
  readonly state: FencingState;
  readonly last: number;
  readonly order: readonly CheckedOperation[];
}

/** The search of one part. */
class PartSearch {
  readonly #seen = new Set<string>();
  longest: readonly CheckedOperation[] = [];
  stuck: readonly CheckedOperation[] = [];

  constructor(readonly operations: readonly CheckedOperation[]) {}

  /** Whether every operation with a seen answer can be taken, from `at`. */
  search(at: SearchState): boolean {
    const open = this.operations.filter((_, index) => !at.taken[index]);
    if (open.every((operation) => operation.output === UNKNOWN)) return true;
    const memo = `${at.taken.map((done) => (done ? "1" : "0")).join("")}|${String(at.last)}|${JSON.stringify(at.state)}`;
    if (this.#seen.has(memo)) return false;
    this.#seen.add(memo);
    if (at.order.length > this.longest.length) this.longest = at.order;
    const deadline = Math.min(
      ...open.filter((operation) => operation.output !== UNKNOWN).map((operation) => operation.to),
    );
    const next = this.operations.flatMap((operation, index) =>
      !at.taken[index] && operation.from <= deadline ? [index] : [],
    );
    for (const index of next) if (this.#tried(at, index)) return true;
    if (at.order.length >= this.longest.length)
      this.stuck = next.map((index) => this.operations[index] ?? never());
    return false;
  }

  /** Whether taking operation `index` next, at some instant (or never, when unseen), leads through. */
  #tried(at: SearchState, index: number): boolean {
    const operation = this.operations[index] ?? never();
    const taken = at.taken.map((done, other) => done || other === index);
    if (operation.output === UNKNOWN && this.search({ ...at, taken })) return true;
    const from = Math.max(operation.from, at.last);
    const to = Number.isFinite(operation.to) ? Math.max(from, operation.to) : from;
    // the earliest instant first; the latest only when the earliest gives another answer than the store's
    const early = applied(at.state, operation, from);
    if (early !== undefined)
      return this.search({ taken, state: early, last: from, order: [...at.order, operation] });
    const late = from === to ? undefined : applied(at.state, operation, to);
    return (
      late !== undefined &&
      this.search({ taken, state: late, last: to, order: [...at.order, operation] })
    );
  }
}

const never = (): never => {
  throw new Error("an operation of the part is missing");
};

/** The parts of `operations` that are not linearizable on the sequential model. */
export function notLinearizable(operations: readonly CheckedOperation[]): NotLinearizable[] {
  return partsOf(operations).flatMap((part) => {
    const search = new PartSearch([...part].sort((left, right) => left.from - right.from));
    const start: SearchState = {
      taken: part.map(() => false),
      state: EMPTY_FENCING_STATE,
      last: Number.NEGATIVE_INFINITY,
      order: [],
    };
    if (search.search(start)) return [];
    return [{ operations: search.operations, longest: search.longest, stuck: search.stuck }];
  });
}
