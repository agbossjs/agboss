/**
 * The invariants of the fault suite (#484 AC1), each a name a broken run is reported by: what must
 * hold after every scenario, whatever fault it injected.
 */
export enum FaultInvariant {
  /** At most one holder of a tree's lease at a time: every epoch granted once, every accepted write its holder's, none after a newer epoch was granted. */
  OneOwner = "one-owner",
  /** No lease of finished work is granted again (#520): a child whose lease was finished is never taken. */
  FinishedWorkUntouched = "finished-work-untouched",
  /** Every child of a batch ran to its end exactly once: none lost, none run twice. */
  ChildrenOnce = "children-once",
  /** Every charge exactly once: one business row, one `Ran` / `Sent`, one payment per order, the rest replayed, reconciled or refused. */
  EffectsOnce = "effects-once",
  /** A hand-over undoes nothing: an undo runs only on a real failure — and once, never again once marked done (#607). */
  NoUndoOnHandOver = "no-undo-on-hand-over",
  /** Every tree ended: a finished order paid, a declined one failed, every batch finished. */
  TreesFinish = "trees-finish",
  /** The store history has an order the sequential model of the fencing stores explains (#533). */
  Linearizable = "linearizable",
}

/** One broken invariant, said plainly. */
export interface FaultViolation {
  readonly invariant: FaultInvariant;
  readonly message: string;
}

/** A run that broke invariants: every violation, each named. */
export class FaultInvariantError extends Error {
  override name = "FaultInvariantError";

  constructor(
    readonly scenario: string,
    readonly violations: readonly FaultViolation[],
    /** The scenario's own expectations that failed too, and why it stopped early. */
    readonly notes: readonly string[] = [],
  ) {
    const lines = violations.map((violation) => `  [${violation.invariant}] ${violation.message}`);
    const also = notes.map((note) => `  (also) ${note}`);
    super(
      `${scenario}: ${String(violations.length)} invariant(s) broken —\n${[...lines, ...also].join("\n")}`,
    );
  }

  /** The invariants broken, each once. */
  get invariants(): readonly FaultInvariant[] {
    return [...new Set(this.violations.map((violation) => violation.invariant))];
  }
}

/** A violation of `invariant`. */
export const violation = (invariant: FaultInvariant, message: string): FaultViolation => ({
  invariant,
  message,
});
