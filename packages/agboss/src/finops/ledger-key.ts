/**
 * A spend's identity across passes (`UsageRecord.ledgerKey`, #810): a charge a step makes again
 * after a takeover — an A2A call's price and its run report's excess, replayed from the accept an
 * earlier pass recorded — is written to the ledger under `id` and dated `madeAt`, so the ledger
 * adds it once whichever pass writes it first. A spend without one gets an id of the pass that
 * made it (#727): made again by another pass, it is billed again.
 */
export interface LedgerKey {
  /** The entry's id in the ledger: derived from what makes the spend one (a call's messageId). */
  readonly id: string;
  /** When the spend was first made (the `Clock`): its entry's date, what the ledger prunes by. */
  readonly madeAt: Date;
}

