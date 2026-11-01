# Payments

How to take payments with AGBoss without charging a customer twice, refunding twice or losing a
payment (#652). This section has three pages:

- **This page:** the notice, the gateway contract in short, whether AGBoss's guarantees hold on your
  gateway, what stays yours, how to wire a gateway and how to check your own gateway call.
- **[Payment scenarios](Payment-scenarios):** every race and failure we know (PS1–PS23), each with
  what goes wrong, what AGBoss does, the guarantee, its assumptions and its boundary.
- **[Payment gateways](Payment-gateways):** the contract (G1–G6) in full, what each requirement
  gives and what breaks without it, and the capability table of ten gateways.

Nothing here claims more than [Guarantees](Guarantees), which states every guarantee (P1–P5) and
the assumptions (A1–A12) it rests on. The mechanisms are on [Several instances](Several-instances),
the fault scenarios that prove them on [Guarantees across processes](Guarantees-across-processes).

## The notice

**Independent examples, not affiliated.** Every gateway in this section is named only to identify
its public API. AGBoss is not affiliated with, endorsed by or sponsored by any of them, and their
names are their owners' trademarks. What a page says about a gateway is quoted from that gateway's
official documentation, with a link and the date it was read. Gateways change their APIs and SDKs:
check the official documentation before you rely on anything here. The examples call each
gateway's official SDK (or, where it has none, its documented HTTP API) against a local stub, never
the gateway itself.

## The contract in short

A charge, a capture or a refund is a call that leaves the system. AGBoss records an intent before
it, and settles it after. When it cannot tell what happened, it asks the gateway instead of sending
again blindly. For that, the gateway must offer:

| # | The gateway must | Required for support |
| --- | --- | --- |
| G1 | accept an idempotency key on each money-moving request you make (charge, capture, refund, void) | **yes**, per operation |
| G2 | tell what happened to a request whose answer was lost: a lookup by the key, a reference you set or an id you hold, or a replay of the key inside a documented retention | **yes** |
| G3 | keep keys at least as long as your longest recovery | you check it against your recovery |
| G4 | answer a repeat with the first response | recommended |
| G5 | refuse the same key with other parameters | recommended (AGBoss checks it too) |
| G6 | tell late outcomes: a status API or webhooks | recommended |

A gateway without G1 or G2, or whose API documentation is not public, is **not supported**: no
example runs on it, and its row in the [capability table](Payment-gateways#the-ten-gateways) says
why. One that keys only some operations is supported for those only (CardCom: charges, not
refunds).

## Do AGBoss's guarantees hold on my gateway?

Read your gateway's documentation and answer in order:

1. **Does it accept an idempotency key on every operation you call?** No → not supported: a retry
   after a timeout can charge twice (PS1, PS6).
2. **Can you learn what happened to a request whose answer was lost?** By a lookup on the key, on
   your own reference or on an id you held before money moved; or by replaying the same key inside
   a retention the docs state. No → not supported: after a crash before the answer, nobody can
   tell whether the customer was charged (PS5). With only the replay, support ends with the
   retention (PS17). A search index that lags proves nothing while it lags.
3. **How long does it keep a key?** Compare it with your longest recovery: the lease (30 s), a
   pause answered days later, an operator's retry. A retry later than that is a new charge
   (PS17).
4. **Do your stores pass `storeConformance` and `faultSuite`, and share one backend with the lease
   store?** No → P1–P3 do not hold (A1, A2).
5. **Do you keep A3–A12 of [Guarantees](Guarantees)?** One slewed database clock, a shared
   `pseudonymKey`, every write inside a step, repeats inside the retention.

If all five hold, every scenario on [Payment scenarios](Payment-scenarios) is either handled by
AGBoss or named as the gateway's or your application's.

## What stays yours

- **The gateway's side:** deduplicating on the key (G1), the lookup (G2), keeping keys (G3), its own
  state machine (a void after a capture), signing its webhooks.
- **The application's side:**
  - building the business key once, from the order, in one form (PS7, PS19);
  - routing `OutboundCallInFlightError` to "payment in progress", never to a new charge (PS8);
  - the aggregate's invariants, such as a balance (PS9);
  - checking a webhook's signature and reading the current status instead of trusting the event
    (PS15, PS16);
  - keeping the key's text, the effect's name and the request stable across deploys (PS12);
  - a lasting "paid" record per order beyond every retention window (PS17);
  - numbering payment attempts after a known decline (PS22).

## How to wire a gateway

The principle: **one outbound call per money-moving operation, keyed by a business key, its
`call.idempotencyKey` given to the gateway, and `reconcile` looking the payment up by a reference
that does not expire.**

<!-- snippet-context
import { Action, ExecutionContext, OutboundCalls, OutboundCallReconciliation, fencedEffectKeyOf } from "@agboss/core";
import { Integer, Text } from "@agboss/core/dto";
interface GatewayPayment {
  readonly paymentId: string;
  readonly status: "succeeded" | "processing" | "failed";
}
declare const gateway: {
  charge(request: { amountCents: number; reference: string }, options: { idempotencyKey: string }): Promise<GatewayPayment>;
  findByReference(reference: string): Promise<GatewayPayment | undefined>;
};
export class OrderChargeDto {
  @Text({ prompt: "the order" })
  orderId!: string;
  @Integer({ prompt: "the amount in cents" })
  amountCents!: number;
}
export class PaymentReceiptDto {
  @Text({ prompt: "the gateway's payment id" })
  paymentId!: string;
}
export class PaymentDeclinedError extends Error {
  static readonly code = "payment.declined";
}
-->

```ts
@Action({
  name: "charge-order-action",
  description: "Charges an order once, whoever asks and whatever fails",
  input: { order: OrderChargeDto },
  output: PaymentReceiptDto,
  deps: [ExecutionContext, OutboundCalls],
})
export class ChargeOrderAction {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly outboundCalls: OutboundCalls,
  ) {}

  async execute(input: { readonly order: { readonly value: OrderChargeDto } }): Promise<PaymentReceiptDto> {
    const { orderId, amountCents } = input.order.value;
    // the order, not the step: a second tool call or a second execution gets the first receipt
    const key = fencedEffectKeyOf(this.executionContext, "charge", { businessKey: `order:${orderId}` });
    const { result } = await this.outboundCalls.send(key, {
      target: "gateway",
      operation: "charge",
      request: { amountCents, reference: orderId }, // its fingerprint: another amount is a conflict
      send: (call) => gateway.charge(call.request, { idempotencyKey: call.idempotencyKey }),
      reconcile: async () => {
        // asked only when an earlier attempt's outcome is unknown: look it up, never resend blindly
        const found = await gateway.findByReference(orderId); // a read that does not lag
        if (found === undefined) return OutboundCallReconciliation.notSent();
        return found.status === "processing"
          ? OutboundCallReconciliation.unknown({ reason: "the payment is still processing" })
          : OutboundCallReconciliation.completed(found);
      },
    });
    // a decline is a real failure: its .onError (or the saga's undo) runs, never a crash's hand-over
    if (result.status === "failed") throw new PaymentDeclinedError(`order ${orderId} declined`);
    return { paymentId: result.paymentId };
  }
}
```

- **The key that goes out** is `call.idempotencyKey`, the same on every attempt, replay and pod.
  A gateway with a shorter limit gets a fixed-length digest of it from your adapter, never a cut
  ([Payment gateways](Payment-gateways#rules-that-follow)).
- **`notSent()` only when you know.** A lookup that may lag (a search index) cannot prove a
  payment does not exist. Answer `unknown`, or `notSent()` only while the gateway still keeps the
  key, so that the resend replays the first payment (G1, G3; [#658](https://github.com/agbossjs/agboss/issues/658)).
- **Refunds, captures and voids** are outbound calls of their own, each with its business key
  (`refund:<payment>:<n>`, `capture:<authorization>:<n>`), PS18–PS20.
- **A webhook** starts an execution, and applies the event in a fenced effect keyed by the
  gateway's event id (PS15).
- **The undo** of a charge is a refund behind an outbound call (PS10, [Rollback](Rollback)).

## How to check your own gateway call

AGBoss does not ship gateway stubs: they live in the examples, and you copy one and keep it current
with your gateway's documentation.

1. **Start from the full example**,
   [`11-safe-payments`](https://github.com/agbossjs/agboss-examples/tree/main/11-safe-payments) of
   agbossjs/agboss-examples (#654). It runs every scenario of
   [Payment scenarios](Payment-scenarios) twice, done wrong and done right, against stub gateways
   at each support level, and reads every charge and refund from the stub's own records.
2. **Point your gateway's official SDK at a stub** that follows that gateway's documented
   behaviour: key retention, the answer to a repeat, the conflict, the lookup. The short
   examples, [`12-payment-gateways`](https://github.com/agbossjs/agboss-examples/tree/main/12-payment-gateways)
   (#655), do this for each supported gateway.
3. **Swap in your own charge step** and run the same scenarios. A step that forgets the key on a
   refund turns the refund-retry scenario (PS19) red.
4. **Probe the generic requirements** with `outboundGatewayChecklist`
   ([Payment gateways](Payment-gateways#the-checklist-offline)), offline against
   `FakeOutboundGateway`, or by hand against your gateway's sandbox.

The two example projects land with #654 and #655, after this page; until then the links above
point to where they will be.
