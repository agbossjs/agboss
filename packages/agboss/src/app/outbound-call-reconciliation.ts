import type { JsonValue } from "../infrastructure/fenced-effect.repository.js";
import type { OutboundCallUnknownOptions } from "./outbound-call-types.js";

/**
 * What `reconcile` answers (#505, #825): a union by `verdict`, built only by
 * `OutboundCallReconciliation.completed` / `notSent` / `unknown` — a look-alike object is refused at
 * compile time (a mark it cannot name) and at run time (`isReconciliation`).
 */

/** What `reconcile` found. */
export enum OutboundCallVerdict {
  /** It happened: here is its result. */
  Completed = "completed",
  /**
   * It never arrived — or the other system replays its key (#658): send it, with the same key;
   * refused past a `KeyReplay`'s `keyRetention`.
   */
  NotSent = "not-sent",
  /** The other system cannot say: the step fails, the intent stays pending. */
  Unknown = "unknown",
}

declare const reconciliationBrand: unique symbol;

/** `reconcile` found the call happened: its result (`OutboundCallReconciliation.completed`). */
export interface CompletedReconciliation<TResult> {
  /** A mark only the three factories give — a literal is not one (#825). */
  readonly [reconciliationBrand]: true;
  readonly verdict: OutboundCallVerdict.Completed;
  /** The other system's result: stored, the step goes on with it (`Reconciled`). */
  readonly result: TResult;
}

/** `reconcile` found the call never arrived (`OutboundCallReconciliation.notSent`). */
export interface NotSentReconciliation {
  /** A mark only the three factories give — a literal is not one (#825). */
  readonly [reconciliationBrand]: true;
  readonly verdict: OutboundCallVerdict.NotSent;
}

/** Nobody can say what happened (`OutboundCallReconciliation.unknown`). */
export interface UnknownReconciliation {
  /** A mark only the three factories give — a literal is not one (#825). */
  readonly [reconciliationBrand]: true;
  readonly verdict: OutboundCallVerdict.Unknown;
  /** Why not: what the operator reads in `OutboundCallUnreconciledError`. */
  readonly reason: string;
}

/**
 * The answer of `reconcile` (#505, #825): a union by `verdict` — a `result` only when it happened, a
 * `reason` only when nobody can say — built only with `completed(result)`, `notSent()` or
 * `unknown({ reason })`: a plain object is not one, at compile time and at run time.
 */
export type OutboundCallReconciliation<TResult> =
  CompletedReconciliation<TResult> | NotSentReconciliation | UnknownReconciliation;

/** The verdicts the factories built: what the protocol takes, nothing else. */
const built = new WeakSet<object>();

/** `verdict`, frozen and marked as built: the one way a verdict is made. */
function marked<TVerdict extends object>(verdict: TVerdict): TVerdict {
  built.add(Object.freeze(verdict));
  return verdict;
}

/** Whether `value` is a verdict the factories built (#825: never a look-alike object). */
export const isReconciliation = (value: unknown): value is OutboundCallReconciliation<unknown> =>
  built.has(value as object);

/** The three ways `reconcile` answers (#505). */
export const OutboundCallReconciliation = Object.freeze({
  /** The call happened: the step goes on with `result` (stored, `Reconciled`), nothing is sent. */
  completed<TResult>(result: TResult & JsonValue<TResult>): CompletedReconciliation<TResult> {
    return marked<CompletedReconciliation<TResult>>({
      verdict: OutboundCallVerdict.Completed,
      result,
    } as CompletedReconciliation<TResult>);
  },

  /**
   * The call never arrived (or the other system replays its key): it is sent once more, with the
   * same key and the next attempt — unless the key is past a `KeyReplay`'s `keyRetention` (#658):
   * `OutboundCallUnreconciledError`, nothing sent.
   */
  notSent(): NotSentReconciliation {
    return marked({ verdict: OutboundCallVerdict.NotSent } as NotSentReconciliation);
  },

  /** Nobody can say: `OutboundCallUnreconciledError`, the intent pending for an operator. */
  unknown(options: OutboundCallUnknownOptions): UnknownReconciliation {
    return marked({
      verdict: OutboundCallVerdict.Unknown,
      reason: options.reason,
    } as UnknownReconciliation);
  },
});
