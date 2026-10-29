import { AGBossError } from "@agboss/core";

/**
 * The payment provider refused a charge: its idempotency key was used before for another charge
 * (another customer or total) — what a real provider answers instead of charging, so a bug that
 * reuses a key is seen, never hidden behind an old charge.
 */
export class PaymentKeyReusedError extends AGBossError {
  static override readonly code: string = "payment.key-reused";

  constructor(readonly idempotencyKey: string) {
    super(`idempotency key ${idempotencyKey} was used for another charge`);
  }
}
