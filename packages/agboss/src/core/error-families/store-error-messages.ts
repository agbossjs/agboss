import type { StoreOutcomeSource } from "../../infrastructure/store-call-timeout.js";

/** The sentences of the `StoreError` variants made of their facts: a store, a call, a record's name — never a stored value. */

/** What `StoreError.OutcomeUnknown` says: the call went out and the caller never heard. */
export const outcomeUnknownMessageOf = (
  facts: Partial<{
    readonly store: string;
    readonly operation: string;
    readonly source: StoreOutcomeSource;
  }>,
): string =>
  facts.store === undefined || facts.operation === undefined || facts.source === undefined
    ? "the store did not say whether the write took effect"
    : `${facts.store}.${facts.operation} failed after it was sent (${facts.source}): its outcome is unknown — it may have taken effect`;

/** What `StoreError.CallTimeout` says: the call was not answered within its limit. */
export const callTimeoutMessageOf = (
  facts: Partial<{
    readonly store: string;
    readonly operation: string;
    readonly source: StoreOutcomeSource;
    readonly timeout: number;
  }>,
): string =>
  facts.store === undefined ||
  facts.operation === undefined ||
  facts.source === undefined ||
  facts.timeout === undefined
    ? "a store call ran past its timeout"
    : `${facts.store}.${facts.operation} did not answer within ${String(facts.timeout)} ms (${facts.source}): its outcome is unknown — it may have taken effect`;

/** What `StoreError.UnreadableRecord` says: the record, its ids and the failing fields — never a value. */
export const unreadableRecordMessageOf = (
  facts: Partial<{
    readonly record: string;
    readonly ids: string;
    readonly fields: string;
    readonly isNotJson: boolean;
  }>,
): string => {
  if (facts.record === undefined) return "a stored record cannot be read";
  const why =
    facts.isNotJson === true
      ? "the text is not valid JSON"
      : `the field(s) ${facts.fields ?? ""} missing or not what the framework wrote`;
  const ids = facts.ids === undefined || facts.ids === "" ? "" : ` (${facts.ids})`;
  return `a stored ${facts.record} is not readable${ids}: ${why}`;
};

/** What `StoreError.LedgerEntryInvalid` says: the save added nothing. */
export const ledgerEntryInvalidMessageOf = (
  facts: Partial<{ readonly index: number; readonly reason: string }>,
): string =>
  facts.index === undefined || facts.reason === undefined
    ? "the ledger entry is not valid"
    : `the ledger was handed no ledger entry at index ${String(facts.index)}: ${facts.reason} — the save added nothing; save only LedgerEntry values (an id, a madeAt Date, a costUsd in Usd)`;

/** What `StoreError.LedgerCutoffInvalid` says: nothing was pruned. */
export const ledgerCutoffInvalidMessageOf = (
  facts: Partial<{ readonly reason: string }>,
): string =>
  facts.reason === undefined
    ? "the ledger's cutoff is not valid"
    : `the ledger was handed no valid Date as its prune's cutoff: ${facts.reason} — nothing was pruned and the pruning mark stays where it was; prune with a valid Date`;

/** What `StoreError.LedgerEntryExpired` says: counting the entries again could count them twice. */
export const ledgerEntryExpiredMessageOf = (
  facts: Partial<{ readonly ledgerIds: readonly string[]; readonly prunedBefore: Date }>,
): string =>
  facts.ledgerIds === undefined || facts.prunedBefore === undefined
    ? "the ledger entry is past its retention"
    : `the ledger may have pruned the entries ${facts.ledgerIds.join(", ")}: made before its pruning mark ${facts.prunedBefore.toISOString()} and not held, counting them again could count them twice — the save added nothing; keep entries longer with @Application({ retention: { costLedgerEntries } })`;
