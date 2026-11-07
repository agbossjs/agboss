import type { Secret } from "@agboss/core";

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
   * The application's PII key (`@Application({ piiKeyField })`, #120): one token per value on every
   * instance. `test` leaves it out — tests make tokens with a fixed key.
   */
  piiPseudonymKey?: Secret;
  /**
   * The application's idempotency key (`@Application({ idempotencyKeyField })`, #825): what the
   * credit desk's business-key fingerprints are keyed by — a secret of its own, never the PII key.
   * `test` and `instances` leave it out — `testWith` gives it a test key.
   */
  idempotencyKey?: Secret;
}
