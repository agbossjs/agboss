import {
  Action,
  ApplicationContext,
  ExecutionContext,
  OutboundCallReconciliation,
  OutboundCalls,
  fencedEffectKeyOf,
  type OutboundCallLookup,
  type OutboundCallOptions,
  type Produced,
} from "../../../index.js";
import { seconds } from "../../../units/index.js";
import { FaultPayment } from "../pod-protocol.js";
import { whereOf } from "./order.actions.js";
import { FaultChargeDto, FaultOrderDto, FaultPaymentDto } from "./order.dto.js";
import { FaultPodLink, FaultStepPoint } from "./pod-link.js";

/**
 * The fault fixture's payment (#484): a call that leaves the system (`OutboundCalls`) to the
 * test's payment gateway, under the order's business key (`order:<id>`, #508) — one payment per
 * order, whatever tree pays it. The gateway lives in the test's process: a pod killed after its
 * request reached it and before its answer came back left a pending intent that the next caller
 * reconciles — by the order's reference, or (#658: a gateway with no lookup) by replaying the key
 * inside the retention the call declares. Every error the gateway answers is of unknown outcome
 * (#657) unless the order's payment is the sabotage that takes each for a definite failure.
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

/**
 * The key retention a replay-only payment declares (#658): shorter than any takeover, which waits
 * for a lease to expire — so a pending call reconciled by another pod is always past it.
 */
export const FAULT_REPLAY_KEY_RETENTION = seconds(1);

/** What a payment declares beside its send and reconcile, by how it talks to the gateway. */
const declaredOf = (
  payment: FaultPayment,
): Pick<OutboundCallOptions<unknown, unknown>, "isDefiniteFailure" | "keyRetention"> => {
  if (payment === FaultPayment.ReplayOnly) return { keyRetention: FAULT_REPLAY_KEY_RETENTION };
  if (payment === FaultPayment.EveryErrorDefinite) return { isDefiniteFailure: () => true };
  return {};
};

const isReplayOnly = (payment: FaultPayment): boolean =>
  payment === FaultPayment.ReplayOnly || payment === FaultPayment.ReplayOnlyUndeclared;

@Action({
  name: "fault-pay-action",
  description: "Pays the order at the gateway, once per order",
  input: { charge: FaultChargeDto, order: FaultOrderDto },
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
    readonly order: Produced<FaultOrderDto, unknown>;
  }): Promise<FaultPaymentDto> {
    const { orderId, chargeId } = input.charge.value;
    const payment = input.order.value.payment as FaultPayment;
    const { signal } = this.executionContext;
    const where = { ...whereOf(this.applicationContext, this.executionContext), orderId };
    await this.faultPodLink.atStep(FaultStepPoint.PayBefore, where, signal);
    const key = fencedEffectKeyOf(this.executionContext, "pay", {
      businessKey: `order:${orderId}`,
    });
    const link = this.faultPodLink;
    const gatewayCall = (op: "charge" | "lookup", idempotencyKey: string) =>
      link.gateway({ op, idempotencyKey, orderId, amount: FAULT_ORDER_AMOUNT }, signal);
    const reconcile = async (lookup: OutboundCallLookup) => {
      if (!isReplayOnly(payment))
        return reconciliationOf(await gatewayCall("lookup", lookup.idempotencyKey));
      // no lookup at the gateway: send it again under the key, which replays the first answer
      const { attempt, attemptStartedAt, keyAge } = lookup;
      link.emit("reconciling", { ...where, attempt, keyAge, attemptStartedAt });
      return OutboundCallReconciliation.notSent();
    };
    const outcome = await this.outboundCalls
      .send<{ orderId: string }, PaymentReceipt>(key, {
        target: "fault-gateway",
        operation: "charge",
        request: { orderId },
        send: async (call) => {
          const answer = await gatewayCall("charge", call.idempotencyKey);
          return { paymentId: (answer as PaymentReceipt).paymentId };
        },
        reconcile,
        ...declaredOf(payment),
      })
      .catch((error: unknown) => {
        link.emit("pay-failed", { ...where, error: error instanceof Error ? error.name : "" });
        throw error;
      });
    link.emit("paid", { ...where, status: outcome.status, paymentId: outcome.result.paymentId });
    await link.atStep(FaultStepPoint.PayAfter, where, signal);
    return { orderId, chargeId, paymentId: outcome.result.paymentId };
  }
}
