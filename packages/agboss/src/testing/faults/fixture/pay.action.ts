import {
  Action,
  ApplicationContext,
  ExecutionContext,
  OutboundCallReconciliation,
  OutboundCalls,
  fencedEffectKeyOf,
  type Produced,
} from "../../../index.js";
import { whereOf } from "./order.actions.js";
import { FaultChargeDto, FaultPaymentDto } from "./order.dto.js";
import { FaultPodLink, FaultStepPoint } from "./pod-link.js";

/**
 * The fault fixture's payment (#484): a call that leaves the system (`OutboundCalls`) to the
 * test's payment gateway, under the order's business key (`order:<id>`, #508) — one payment per
 * order, whatever tree pays it. The gateway lives in the test's process: a pod killed after its
 * request reached it and before its answer came back left a pending intent that the next caller
 * reconciles by the call's idempotency key.
 */

/** The gateway's answer: the payment's id. */
interface PaymentReceipt {
  readonly paymentId: string;
}

/** What the gateway's lookup found, as a reconciliation. */
const reconciliationOf = (found: unknown): OutboundCallReconciliation<PaymentReceipt> =>
  typeof found === "object" && found !== null && "paymentId" in found
    ? OutboundCallReconciliation.completed({ paymentId: String(found.paymentId) })
    : OutboundCallReconciliation.notSent();

/** The amount every fixture order pays. */
export const FAULT_ORDER_AMOUNT = 10;

@Action({
  name: "fault-pay-action",
  description: "Pays the order at the gateway, once per order",
  input: { charge: FaultChargeDto },
  output: FaultPaymentDto,
  deps: [ApplicationContext, ExecutionContext, OutboundCalls, FaultPodLink],
})
export class FaultPayAction {
  constructor(
    private readonly applicationContext: ApplicationContext,
    private readonly executionContext: ExecutionContext,
    private readonly outboundCalls: OutboundCalls,
    private readonly faultPodLink: FaultPodLink,
  ) {}

  async execute(input: {
    readonly charge: Produced<FaultChargeDto, unknown>;
  }): Promise<FaultPaymentDto> {
    const { orderId, chargeId } = input.charge.value;
    const { signal } = this.executionContext;
    const where = { ...whereOf(this.applicationContext, this.executionContext), orderId };
    await this.faultPodLink.atStep(FaultStepPoint.PayBefore, where, signal);
    const key = fencedEffectKeyOf(this.executionContext, "pay", {
      businessKey: `order:${orderId}`,
    });
    const link = this.faultPodLink;
    const amount = FAULT_ORDER_AMOUNT;
    const outcome = await this.outboundCalls.send<{ orderId: string }, PaymentReceipt>(key, {
      target: "fault-gateway",
      operation: "charge",
      request: { orderId },
      send: async (call) => {
        const call_ = {
          op: "charge",
          idempotencyKey: call.idempotencyKey,
          orderId,
          amount,
        } as const;
        const answer = await link.gateway(call_, call.signal);
        return { paymentId: (answer as PaymentReceipt).paymentId };
      },
      reconcile: async (lookup) => {
        const call_ = {
          op: "lookup",
          idempotencyKey: lookup.idempotencyKey,
          orderId,
          amount,
        } as const;
        return reconciliationOf(await link.gateway(call_, signal));
      },
    });
    link.emit("paid", { ...where, status: outcome.status, paymentId: outcome.result.paymentId });
    await link.atStep(FaultStepPoint.PayAfter, where, signal);
    return { orderId, chargeId, paymentId: outcome.result.paymentId };
  }
}
