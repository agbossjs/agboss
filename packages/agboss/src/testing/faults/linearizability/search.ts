import { EMPTY_FENCING_STATE, type FencingState } from "../../contracts/models/lease-model.js";
import { applied, leaseSetBy, objectsOf } from "./apply.js";
import { UNKNOWN, type CheckedOperation } from "./operations.js";

/**
 * The search of a linearization (#533 item 5, Wing & Gong with Porcupine's memo): operations that
 * touch no common object are checked apart (a lease's tree, its scope, a call's identity); within
 * one part, the next operation taken is one invoked before every operation still to take completed
 * (the exact real-time order of the machine's clock), at an instant within its span widened by the
 * slack and not before the last one taken — never after its own end (#617): an operation that
 * completed took effect by then. The instants tried, earliest first, are where the model's answers
 * can change: the span's start, just before and at each lease expiry of the state inside the span,
 * where the expiry the operation sets meets another span's end (#660), and its end. An operation whose answer nobody saw may never have taken effect, or may have at
 * any instant after its invoke (its span has no end: a store can apply a request whose caller is
 * gone). A state already reached with the same operations taken and the same last instant is not
 * searched again.
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
  /** Every finite span end of the part: where a later answer can flip (#660). */
  readonly #ends: readonly number[];
  longest: readonly CheckedOperation[] = [];
  stuck: readonly CheckedOperation[] = [];

  constructor(readonly operations: readonly CheckedOperation[]) {
    this.#ends = operations.flatMap(({ from, to }) => [from, to]).filter(Number.isFinite);
  }

  /** Whether every operation with a seen answer can be taken, from `at`. */
  search(at: SearchState): boolean {
    const open = this.operations.filter((_, index) => !at.taken[index]);
    if (open.every((operation) => operation.output === UNKNOWN)) return true;
    const memo = `${at.taken.map((done) => (done ? "1" : "0")).join("")}|${String(at.last)}|${JSON.stringify(at.state)}`;
    if (this.#seen.has(memo)) return false;
    this.#seen.add(memo);
    if (at.order.length > this.longest.length) this.longest = at.order;
    const deadline = Math.min(
      ...open
        .filter((operation) => operation.output !== UNKNOWN)
        .map((operation) => operation.completedAt),
    );
    const next = this.operations.flatMap((operation, index) =>
      !at.taken[index] && operation.invokedAt <= deadline ? [index] : [],
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
    return instantsOf(at.state, operation, at.last, this.#ends).some((instant) => {
      const state = applied(at.state, operation, instant);
      const order = [...at.order, operation];
      return state !== undefined && this.search({ taken, state, last: instant, order });
    });
  }
}

/** Just before an instant: the last moment a lease expiring then is still live. */
const JUST_BEFORE = 0.001;

/**
 * Where a later answer can flip between live and expired because of the instant `operation` takes
 * effect at (#660): one that sets an expiry `d` after it, taken at `end − d` or just after, ends its
 * lease at or just past `end`, for each span end of the part. The rest set no expiry: none.
 */
function flipsOf(operation: CheckedOperation, ends: readonly number[]): readonly number[] {
  const length = leaseSetBy(operation);
  if (length === undefined) return [];
  return ends.flatMap((end) => [end - length, end - length + JUST_BEFORE]);
}

/**
 * The instants `operation` may take effect at after `last`, earliest first (#617): its span's start,
 * just before and at each lease expiry of `state` inside the span, where the expiry it sets makes a
 * later answer flip (#660: `ends`, the part's span ends), and its end — none when the span ended
 * before `last`.
 */
function instantsOf(
  state: FencingState,
  operation: CheckedOperation,
  last: number,
  ends: readonly number[],
): readonly number[] {
  const from = Math.max(operation.from, last);
  const to = operation.output === UNKNOWN ? Number.POSITIVE_INFINITY : operation.to;
  if (from > to) return [];
  const expiries = Object.values(state.leases).flatMap(({ expiresAt }) => [
    expiresAt - JUST_BEFORE,
    expiresAt,
  ]);
  const inside = [...expiries, ...flipsOf(operation, ends)].filter(
    (instant) => instant > from && instant <= to,
  );
  const end = Number.isFinite(to) && to > from ? [to] : [];
  return [...new Set([from, ...inside, ...end])].sort((left, right) => left - right);
}

const never = (): never => {
  throw new Error("an operation of the part is missing");
};

/** The parts of `operations` that are not linearizable on the sequential model. */
export function notLinearizable(operations: readonly CheckedOperation[]): NotLinearizable[] {
  return partsOf(operations).flatMap((part) => {
    const search = new PartSearch(
      [...part].sort((left, right) => left.invokedAt - right.invokedAt),
    );
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
