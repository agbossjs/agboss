import {
  Action,
  ExecutionContext,
  fencedEffectKeyOf,
  optional,
  SqliteFencedEffectRepository,
  type ActionHandler,
  type InputOf,
  type OutputOf,
} from "@agboss/core";
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
 * customer or total is refused (`IdempotencyKeyConflictError`) and charges nothing; an instance
 * that lost the lease is refused (`ExecutionFencedError`, a hand-over) and writes nothing.
 */
@Action({
  name: "charge-card-action",
  description: "Charges the customer's card for the order",
  input: {
    order: CreditOrderDto,
    approval: optional(CreditApprovalDto), // present after ApprovalAgent
  },
  output: ChargeResultDto,
  deps: [ExecutionContext, SqliteFencedEffectRepository, PaymentLedgerRepository],
})
export class ChargeCardAction implements ActionHandler<ChargeCardAction> {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly sqliteFencedEffectRepository: SqliteFencedEffectRepository,
    private readonly paymentLedgerRepository: PaymentLedgerRepository,
  ) {}

  async execute(input: InputOf<ChargeCardAction>): Promise<OutputOf<ChargeCardAction>> {
    const { applicationId, customerId, total } = input.order.value;
    const key = fencedEffectKeyOf(this.executionContext, "charge", {
      businessKey: `credit:${applicationId}`,
      fingerprint: { customerId, total },
    });
    const { result } = await this.sqliteFencedEffectRepository.saveResultIfAbsent(key, (database) =>
      this.paymentLedgerRepository.recordCharge(database, { customerId, total }),
    );
    return { chargeId: result.chargeId };
  }
}
