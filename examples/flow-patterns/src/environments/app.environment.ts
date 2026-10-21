import type { Secret } from "agboss";

/**
 * The patterns' environment contract (#261): declared fields only — the values are in each
 * `<name>.environment.ts` here. The application lists `SqliteCostLedgerRepository`, so its tenant and
 * application budgets are counted across instances and restarts — on the file this field names.
 */
export class AppEnvironment {
  /** The file of the SQLite cost ledger (`:memory:` in tests). */
  sqlitePath!: string;
  /**
   * The application's PII key (`@Application({ pseudonymKey })`, #120): one token per value on every
   * instance. `test` leaves it out — tests make tokens with a fixed key.
   */
  piiPseudonymKey?: Secret;
}
