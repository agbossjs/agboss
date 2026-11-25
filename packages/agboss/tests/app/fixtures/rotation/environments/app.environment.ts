import type { Secret } from "../../../../../src/index.js";

/**
 * The rotation fixture's contract (#825): a provider's key, never an idempotency key. The SQLite
 * file and the idempotency keys are the applications' `@DatabaseStorage`'s (`test` leaves them out).
 */
export class RotationEnvironment {
  /** A provider's key: never an idempotency key (`test` leaves it out). */
  openRouterApiKey?: Secret;
}
