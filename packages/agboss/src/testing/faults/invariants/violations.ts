import { causeOptionOf } from "../../../core/errors.js";
/**
 * The invariants of the fault suite (#484 AC1), each a name a broken run is reported by: what must
 * hold after every scenario, whatever fault it injected.
 */
export enum FaultInvariant {
  /** At most one holder of a tree's lease at a time: every epoch granted once, every accepted write its holder's, none after a newer epoch was granted. */
  OneOwner = "one-owner",
  /** No lease of finished work is granted again (#520): a child whose lease was finished is never taken. */
  FinishedWorkUntouched = "finished-work-untouched",
  /** Every child of a batch ran to its end once: none lost, none run twice; its end heard at most once. */
  ChildrenOnce = "children-once",
  /** Every charge exactly once: one business row, one `Ran` / `Sent`, one payment per order, the rest replayed, reconciled or refused. */
  EffectsOnce = "effects-once",
  /** A hand-over undoes nothing: an undo runs only on a real failure — and once, never again once marked done (#607). */
  NoUndoOnHandOver = "no-undo-on-hand-over",
  /** Every tree ended: a finished order paid, a declined one failed, every batch finished. */
  TreesFinish = "trees-finish",
  /** The store history has an order the sequential model of the fencing stores explains (#533). */
  Linearizable = "linearizable",
  /**
   * One execution per A2A task, its end for good (#811): no state after a terminal one, one root
   * under its id, nothing run by a task settled start-lost, no effect after a cancel it was told.
   */
  A2ATasksOnce = "a2a-tasks-once",
  /**
   * No effect after a durable cancel (#909): a fenced write that ran, an intent recorded or an
   * attempt claimed — its store operation invoked after the tree's `requestCancel` answered —
   * except an undo's, the cancel's own unwinding.
   */
  NoEffectAfterCancel = "no-effect-after-cancel",
}

/** One broken invariant, said plainly. */
export interface FaultViolation {
  readonly invariant: FaultInvariant;
  readonly message: string;
}

/** What a broken run takes (#906): the scenario, each violation, and the notes of what else failed. */
export interface FaultInvariantErrorOptions {
  readonly scenario: string;
  readonly violations: readonly FaultViolation[];
  readonly notes?: readonly string[];
  readonly cause?: unknown;
}

/** A run that broke invariants: every violation, each named. */
export class FaultInvariantError extends Error {
  static readonly code = "fault.invariant" as const;
  readonly code = FaultInvariantError.code;
  override name = "FaultInvariantError";
  readonly scenario: string;
  readonly violations: readonly FaultViolation[];
  /** The scenario's own expectations that failed too, and why it stopped early. */
  readonly notes: readonly string[];

  constructor(options: FaultInvariantErrorOptions) {
    const { scenario, violations, notes = [], cause } = options;
    const lines = violations.map((violation) => `  [${violation.invariant}] ${violation.message}`);
    const also = notes.map((note) => `  (also) ${note}`);
    super(
      `${scenario}: ${String(violations.length)} invariant(s) broken —\n${[...lines, ...also].join("\n")}`,
      causeOptionOf(cause),
    );
    this.scenario = scenario;
    this.violations = violations;
    this.notes = notes;
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
