import { Injectable } from "@agboss/core";
import { PaymentKeyReusedError } from "../errors/payment-key-reused.error.js";
import { PaymentLedgerRepository } from "../repositories/payment-ledger.repository.js";

/** What a charge asks the payment provider: whom, how much, under which idempotency key. */
export interface ChargeRequest {
  readonly customerId: string;
  /** Whole dollars. */
  readonly total: number;
  /**
   * The step's `executionContext.step.idempotencyKey`: the same when the step runs again after a
   * crash, so the provider can tell a retry from a new charge.
   */
  readonly idempotencyKey: string;
}

/** A charge the provider made. */
export interface Charge {
  readonly chargeId: string;
}

/**
 * The payment provider, offline (a stand-in for a real provider's client). Where the duty lies:
 * - AGBoss runs a step at least once — a step whose instance died before its checkpoint was saved
 *   runs again on another instance, with the same `step.idempotencyKey`;
 * - the action passes that key with the charge;
 * - the provider makes **one** charge per key, atomically, and answers a retry with the charge it
 *   made — `PaymentLedgerRepository.recordOnce` here; a real provider's `Idempotency-Key`. A
 *   provider that ignores the key charges twice, and nothing on the AGBoss side can prevent it;
 *   a key used before for another charge is refused (`PaymentKeyReusedError`), as real providers do.
 *
 * This deduplicates retries of one step; it does not fence a stalled instance that wakes up after
 * another took its lease over — see agbossjs/distributed-agent-recovery for that.
 */
@Injectable({ deps: [PaymentLedgerRepository] })
export class PaymentService {
  constructor(private readonly paymentLedgerRepository: PaymentLedgerRepository) {}

  charge(request: ChargeRequest): Promise<Charge> {
    const charged = this.paymentLedgerRepository.recordOnce(request);
    if (charged.customerId !== request.customerId || charged.total !== request.total)
      return Promise.reject(new PaymentKeyReusedError(request.idempotencyKey));
    return Promise.resolve({
      chargeId: `charge-${charged.customerId}-${String(charged.chargeNumber)}`,
    });
  }
}
