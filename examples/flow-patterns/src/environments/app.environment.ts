import type { Secret } from "agboss";

/**
 * The patterns' environment contract (#261): declared fields only — the values are in each
 * `<name>.environment.ts` here. The application lists the SQLite implementations, so its budgets,
 * records, pauses and checkpoints outlive a process — in the file `sqlitePath` names.
 */
export class AppEnvironment {
  /**
   * OpenRouter's key — read by both built-in model providers (#266) for a real run. `test` leaves
   * it out: tests script every model.
   */
  openRouterApiKey?: Secret;
  /** OpenRouter's base URL (a proxy, a local server); unset → the providers' default. */
  openRouterBaseUrl?: string;
  /** The file of the SQLite implementations the application lists (`:memory:` in tests). */
  sqlitePath!: string;
  /**
   * The application's PII key (`@Application({ pseudonymKey })`, #120): one token per value on every
   * instance. `test` leaves it out — tests make tokens with a fixed key.
   */
  piiPseudonymKey?: Secret;
}
