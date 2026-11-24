import {
  Action,
  Idempotency,
  optional,
  type ActionHandler,
  type InputOf,
  type OutputOf,
} from "@agboss/core";
import { hours } from "@agboss/core/units";
import { ChargeResultDto } from "../dto/charge-result.dto.js";
import { CreditApprovalDto } from "../dto/credit-approval.dto.js";
import { CreditOrderDto } from "../dto/credit-order.dto.js";
import { PaymentLedgerRepository } from "../repositories/payment-ledger.repository.js";

/**
 * Charges the customer's card for the order; reached from the router and from the approval. A
 * side effect: the step runs at least once, so the charge is a fenced effect (#500) — its row and
 * its receipt in one transaction of the application's SQLite file, checked against the step's
 * lease. It is keyed by the credit application (#508, `credit:<applicationId>`), not the step: a
 * step run again (a crash before its checkpoint) and a second execution for the same application
 * (another request, another thread) get the first receipt; the same application with another
 * customer or total is refused (`IdempotencyError.KeyConflict`) and charges nothing; an instance
 * that lost the lease is refused (`ExecutionError.Fenced`, a hand-over) and writes nothing. It
 * injects the application's `Idempotency` (#890, #1317), never the store: the store is the one the
 * application's storage lists (`SqliteFencedEffectRepository`); the repository writes through its connection's `requireTransaction()` (#1317c).
 */
@Action({
  name: "charge-card-action",
  description: "Charges the customer's card for the order",
  input: {
    order: CreditOrderDto,
    approval: optional(CreditApprovalDto), // present after ApprovalAgent
  },
  output: ChargeResultDto,
  deps: [Idempotency, PaymentLedgerRepository],
})
export class ChargeCardAction implements ActionHandler<ChargeCardAction> {
  constructor(
    private readonly idempotency: Idempotency,
    private readonly paymentLedgerRepository: PaymentLedgerRepository,
  ) {}

  async execute(input: InputOf<ChargeCardAction>): Promise<OutputOf<ChargeCardAction>> {
    const { applicationId, customerId, total } = input.order.value;
    const { result } = await this.idempotency.runOnce({
      name: "charge",
      key: `credit:${applicationId}`,
      fingerprint: { customerId, total },
      ttl: hours(24),
      execute: () => this.paymentLedgerRepository.recordCharge({ customerId, total }),
    });
    return { chargeId: result.chargeId };
  }
}
