import type { JsonValue } from "../infrastructure/fenced-effect.repository.js";
import type { Milliseconds } from "../units/index.js";
import type { OutboundCallLookup } from "./outbound-call-types.js";

/**
 * How a call that left the system is recovered when its outcome is not known (#1317): what
 * `reconcile` answers (`Reconciliation`) and how the answer, or the other system's replay of the
 * key, is trusted (`OutboundRecovery`). Both are built only by their factories — a look-alike
 * object is refused at compile time (a mark it cannot name) and at run time (`isReconciliation`,
 * `isOutboundRecovery`).
 */

/** What a lookup found. */
export enum ReconciliationVerdict {
  /** It happened: here is its result. */
  Completed = "completed",
  /** It was never carried out: send it again, with the same key (while the recovery trusts that). */
  NotExecuted = "not-executed",
  /** The other system cannot say: the step fails, the intent stays pending. */
  Unknown = "unknown",
}

declare const reconciliationBrand: unique symbol;

/** The lookup found the call happened: its result (`Reconciliation.completed`). */
export interface CompletedReconciliation<out TResult> {
  /** A mark only the factories give — a literal is not one. */
  readonly [reconciliationBrand]: true;
  readonly verdict: ReconciliationVerdict.Completed;
  /** The other system's result: stored, the step goes on with it (`Reconciled`). */
  readonly result: TResult;
}

/** The lookup found the call never carried out (`Reconciliation.notExecuted`). */
export interface NotExecutedReconciliation {
  readonly [reconciliationBrand]: true;
  readonly verdict: ReconciliationVerdict.NotExecuted;
}

/** Nobody can say what happened (`Reconciliation.unknown`). */
export interface UnknownReconciliation {
  readonly [reconciliationBrand]: true;
  readonly verdict: ReconciliationVerdict.Unknown;
  /** Why not: what the operator reads in `OutboundCallError.Unreconciled`. */
  readonly reason: string;
}

/** The answer of a lookup: a union by `verdict`, built only by `Reconciliation.completed` / `notExecuted` / `unknown`. */
export type Reconciliation<TResult = never> =
  CompletedReconciliation<TResult> | NotExecutedReconciliation | UnknownReconciliation;

const built = new WeakSet<object>();

function marked<TVerdict extends object>(verdict: TVerdict): TVerdict {
  built.add(Object.freeze(verdict));
  return verdict;
}

/** Whether `value` is a verdict the factories built (never a look-alike object). */
export const isReconciliation = (value: unknown): value is Reconciliation<unknown> =>
  built.has(value as object);

/** The three answers of a lookup. */
export const Reconciliation = Object.freeze({
  /** The call happened: the step goes on with `result` (stored, `Reconciled`), nothing is sent. */
  completed<TResult>(result: TResult & JsonValue<TResult>): CompletedReconciliation<TResult> {
    return marked({
      verdict: ReconciliationVerdict.Completed,
      result,
    } as CompletedReconciliation<TResult>);
  },

  /** The call was never carried out: it is sent once more with the same key, the next attempt. */
  notExecuted(): NotExecutedReconciliation {
    return marked({ verdict: ReconciliationVerdict.NotExecuted } as NotExecutedReconciliation);
  },

  /** Nobody can say: `OutboundCallError.Unreconciled`, the intent pending for an operator. */
  unknown(reason: string): UnknownReconciliation {
    return marked({ verdict: ReconciliationVerdict.Unknown, reason } as UnknownReconciliation);
  },
});

declare const recoveryBrand: unique symbol;

/** The other system replays the key for `keyTtl`: a resend inside it is the same call, so nothing is looked up. */
export interface ReplayRecovery {
  readonly [recoveryBrand]: true;
  readonly kind: "replay-within";
  readonly keyTtl: Milliseconds;
}

/** A lookup of the other system decides, for good (`permanentLookup`) or only while it keeps the key (`lookupWithin`). */
export interface LookupRecovery<out TResult> {
  readonly [recoveryBrand]: true;
  readonly kind: "permanent-lookup" | "lookup-within";
  /** How long the other system keeps the key: none for a record that does not expire. */
  readonly keyTtl: Milliseconds | undefined;
  readonly reconcile: (
    call: OutboundCallLookup,
  ) => Reconciliation<TResult> | Promise<Reconciliation<TResult>>;
}

/** How a call whose outcome is unknown is recovered: built only by `OutboundRecovery.*`. */
export type OutboundRecovery<TResult = never> = ReplayRecovery | LookupRecovery<TResult>;

const recoveries = new WeakSet<object>();

/** Whether `value` is a recovery the factories built. */
export const isOutboundRecovery = (value: unknown): value is OutboundRecovery<unknown> =>
  recoveries.has(value as object);

function recovery<TRecovery extends object>(value: TRecovery): TRecovery {
  recoveries.add(Object.freeze(value));
  return value;
}

/** The ways a call whose outcome is unknown is recovered. */
export const OutboundRecovery = Object.freeze({
  /**
   * The other system deduplicates by the key for `keyTtl` (Stripe `hours(24)`): an unknown outcome is
   * resent with the same key while the key is younger than `keyTtl` less the call's timeout; later
   * nothing is sent — `OutboundCallError.Unreconciled`, for an operator.
   */
  replayWithin(keyTtl: Milliseconds): ReplayRecovery {
    return recovery({ kind: "replay-within", keyTtl } as ReplayRecovery);
  },

  /** A record the other system keeps for good decides what happened, at any age of the key. */
  permanentLookup<TResult>(
    reconcile: LookupRecovery<TResult>["reconcile"],
  ): LookupRecovery<TResult> {
    return recovery({
      kind: "permanent-lookup",
      keyTtl: undefined,
      reconcile,
    } as LookupRecovery<TResult>);
  },

  /** A lookup decides, and its `notExecuted()` is trusted only while the other system keeps the key (`keyTtl`). */
  lookupWithin<TResult>(
    keyTtl: Milliseconds,
    reconcile: LookupRecovery<TResult>["reconcile"],
  ): LookupRecovery<TResult> {
    return recovery({ kind: "lookup-within", keyTtl, reconcile } as LookupRecovery<TResult>);
  },
});
