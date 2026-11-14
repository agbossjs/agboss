import { StoreOutcomeUnknownError } from "../../../infrastructure/store-call-timeout.js";

/**
 * Whether `error` carries a store call of unknown outcome (#928) in its chain of causes: what a
 * holder's call that the store did not answer in time rejects with (the lease lost, its cause the
 * timeout). The framework hands the tree over on it; the sabotages of #928 act on it instead.
 */
export function isUnknownOutcome(error: unknown): boolean {
  for (let current = error, depth = 0; current instanceof Error && depth < 8; depth += 1) {
    if (current instanceof StoreOutcomeUnknownError) return true;
    current = current.cause;
  }
  return false;
}
