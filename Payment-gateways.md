# Payment gateways

A charge is a call that leaves the system ([Several instances](Several-instances#calls-that-leave-the-system-505)).
AGBoss records an intent before every such call, and reconciles one left pending instead of sending
it again blindly. Whether a customer can be charged twice depends on what the gateway supports. This
page lists those requirements, what AGBoss guarantees with and without each, what widely used
gateways document, and a checklist a team runs against its own gateway.

## The requirements

| # | Requirement | What AGBoss gives with it | Without it |
| --- | --- | --- | --- |
| G1 | Accepts a client idempotency key per request | A send retried after an error (`Failed` → sent again, the same key) is deduplicated by the gateway | A crash after sending can charge twice; only `reconcile` with G2 prevents it |
| G2 | Finds a payment by that key, or by a client reference you set | `reconcile` asks what happened: never a blind resend | An unknown outcome stays `unknown`: `OutboundCallUnreconciledError`, a person decides |
| G3 | Keeps keys at least as long as the longest recovery: the lease (30 s), the sweep (30 s), a pause or an operator's retry, stated in days | Replays inside the window are safe | A late replay after the window is a new charge |
| G4 | Returns the first response on a repeat | A repeat carries the real receipt | A repeat cannot be told from a new charge |
| G5 | Refuses the same key with other parameters | A bug or a tampered request is caught at the gateway too | Only AGBoss's own check catches it (a business key's fingerprint, #508) |
| G6 | Tells late outcomes: a status API or webhooks | `unknown` turns into a decision later | Pending intents need manual review |

## Can I be charged twice?

| The gateway supports | A crash before the answer | A provider error, then a retry | A late replay (days later) |
| --- | --- | --- | --- |
| G1 + G2 + G3 | No: `reconcile` finds the payment by its key | No: the gateway deduplicates the key | No, inside G3's window; yes after it |
| G1 + G3, no G2 | No while the key lives, if you make `reconcile` answer `notSent()` and rely on G1 to deduplicate; with `unknown()`, a person decides | No | Yes after the window |
| G2, no G1 | No: `reconcile` finds it, if it looks the payment up by your reference | **Yes** if the "error" was a timeout the gateway processed: the retry is a new charge — let the timeout abort the step instead, so `reconcile` decides | No while `reconcile` still finds it by your reference; **yes** once the gateway no longer finds it |
| Neither | **Yes**: nothing can tell what happened; `reconcile` can only answer `unknown` | **Yes** | **Yes** |

Rules that follow:

- **Without G1, a timeout must not be a failure.** `OutboundCalls` records `Failed` when `send`
  throws and sends the next attempt with the same key: safe only when the gateway deduplicates the
  key (G1). Without G1, a timeout means "it may have been charged": let the step's signal abort the
  wait (a timeout, a lost lease) — an aborted send leaves the intent `Pending` — and on the next
  attempt `reconcile` decides, answering `unknown()` when it cannot look the payment up (G2).
- **A send that never returns is bounded, and then G1 is what prevents a second charge.** Another
  instance sees a pending call in flight while its holder's lease is live — for at most
  `@Application({ outboundCalls: { attemptTimeout } })` (default `minutes(2)`, from the attempt's
  start) plus up to the lease's 30 s. A send still hung past this bound can coincide with a
  reconcile and a resend; the provider must deduplicate on `call.idempotencyKey` (G1). The hung
  send's own answer, when it comes, is fenced and logged (`outbound-call.answered-after-hand-over`),
  never stored ([Several instances](Several-instances#business-idempotency-keys-508)).
- **Fit the key to the gateway, never by cutting it.** `call.idempotencyKey` has no fixed length:
  the step's key and the call's name (about 60 characters with a UUID execution id), or the tenant,
  the URI-encoded business key and the name (up to hundreds). A gateway with a shorter limit —
  Square takes 45 characters — gets a fixed-length digest of it from your adapter, such as its
  SHA-256 in base64url (43 characters): the same call always sends the same key and two calls never
  share one. A key cut short can make two orders one payment ([#532](https://github.com/agbossjs/agboss/issues/532)).
- **Look up by key, not by the request.** `reconcile` gets the request as stored, masked by the PII
  policies; `lookup.idempotencyKey` is what the gateway knows the call by.
- **Keep keys longer than your longest recovery.** A paused execution answered tomorrow replays
  its step tomorrow.

## What the gateways document

Read on **2026-10-30**, from each vendor's official documentation only. A cell says "not
documented" when the docs did not say it.

| Gateway | G1 key | G2 lookup | G3 retention | G4 first response | G5 conflict | G6 late outcomes |
| --- | --- | --- | --- | --- | --- | --- |
| **Stripe** | `Idempotency-Key` header on every POST ([source](https://docs.stripe.com/api/idempotent_requests)) | By your reference only: `metadata` + `GET /v1/payment_intents/search`; search can lag ~1 min, "Don't use search for read-after-write flows" ([source](https://docs.stripe.com/search), [API](https://docs.stripe.com/api/payment_intents/search)) | Keys may be pruned once at least 24 h old (API v1) ([source](https://docs.stripe.com/api/idempotent_requests)) | Yes, the saved status and body, 500s included; not for validation failures or concurrent conflicts ([source](https://docs.stripe.com/api/idempotent_requests)) | Yes, it compares the parameters and errors; no code named ([source](https://docs.stripe.com/api/idempotent_requests)) | Webhooks ([source](https://docs.stripe.com/webhooks)) and retrieving the PaymentIntent |
| **Adyen** | `idempotency-key` header ([source](https://docs.adyen.com/development-resources/api-idempotency)) | Not documented | 7 to 14 days ([source](https://docs.adyen.com/development-resources/api-idempotency)) | Yes, the first attempt's response ([source](https://docs.adyen.com/development-resources/api-idempotency)) | Not documented (only a duplicate still in progress: 422 or 409, code 704) | Webhooks ([source](https://docs.adyen.com/development-resources/webhooks)); a status API not documented |
| **PayPal** (REST v2) | `PayPal-Request-Id` header, optional, not on every API ([source](https://developer.paypal.com/api/rest/reference/idempotency/), [Orders](https://developer.paypal.com/docs/api/orders/v2/orders-create)) | By order id only (`GET /v2/checkout/orders/{id}`); by `reference_id`, `invoice_id` or request id not documented ([source](https://developer.paypal.com/docs/api/orders/v2/)) | Not documented in general ("for a period of time"); 45 days in a refund example only ([source](https://developer.paypal.com/api/rest/requests/)) | Partly: the current status of the earlier request, not its original response ([source](https://developer.paypal.com/api/rest/reference/idempotency/)) | Not documented | Webhooks ([source](https://developer.paypal.com/api/rest/webhooks/)) and the order's GET |
| **Braintree** | Not documented for `transaction.sale` ([source](https://developer.paypal.com/braintree/docs/reference/request/transaction/sale)); Duplicate Transaction Checking instead: the same amount, order id and payment method within 30 s is rejected ([source](https://developer.paypal.com/braintree/articles/control-panel/transactions/duplicate-checking)) | By your reference: transaction search on `order_id` ([source](https://developer.paypal.com/braintree/docs/reference/request/transaction/search)) | Not documented (the duplicate check's window: 30 s by default) ([source](https://developer.paypal.com/braintree/articles/control-panel/transactions/duplicate-checking)) | Not documented (a duplicate is rejected) | Not documented | Webhooks ([source](https://developer.paypal.com/braintree/docs/guides/webhooks/overview)) and `Transaction.find` ([source](https://developer.paypal.com/braintree/docs/reference/request/transaction/find)) |
| **Checkout.com** | `Cko-Idempotency-Key` header ([source](https://www.checkout.com/docs/developer-resources/api/idempotency)) | By your reference: `GET /payments` filtered by reference ([source](https://www.checkout.com/docs/payments/manage-payments/get-a-list-of-payments)) | 72 hours, sandbox and production ([source](https://www.checkout.com/docs/developer-resources/api/idempotency)) | Yes, for an original that answered 2xx ([source](https://www.checkout.com/docs/developer-resources/api/idempotency)) | Not documented (only a concurrent request: 409) | Webhooks ([source](https://www.checkout.com/docs/developer-resources/webhooks)) and `GET /payments/{id}` ([source](https://www.checkout.com/docs/payments/manage-payments/get-payment-details)) |
| **Square** | `idempotency_key` in the body, up to 45 characters ([source](https://developer.squareup.com/reference/square/payments-api/create-payment)) | Not documented (`reference_id` exists; List payments has no filter by it or by the key) ([source](https://developer.squareup.com/reference/square/payments-api/list-payments)) | Not documented | Yes, `200` with the existing resource ([source](https://developer.squareup.com/docs/build-basics/general-considerations/using-rest-api)) | Yes, `400 IDEMPOTENCY_KEY_REUSED` ([source](https://developer.squareup.com/reference/square/enums/ErrorCode)) | Webhooks ([source](https://developer.squareup.com/docs/webhooks/overview)) and `GET /v2/payments/{payment_id}` ([source](https://developer.squareup.com/reference/square/payments-api/get-payment)) |

What it means, read against the matrix above:

- **Stripe, Checkout.com:** G1, G3 and G4 hold. Reconcile by your own reference (Stripe's
  `metadata` search lags; Checkout.com's list by `reference`): set it to `lookup.idempotencyKey`.
- **Adyen:** G1, G3, G4. No documented lookup: `reconcile` relies on the webhook's outcome (G6),
  stored by your own code, or answers `unknown`.
- **PayPal:** G1 is optional and a repeat returns the current status. With no documented lookup by
  your reference, keep the order id the first call created, or answer `unknown`.
- **Braintree:** no idempotency key on a sale: a retry after a timeout is a new transaction unless
  the 30-second duplicate check catches it. Map a timeout to `unknown`, look up by `order_id`.
- **Square:** G1, G4, G5. No documented lookup by key or reference and no stated retention: keep
  the payment id, or answer `unknown`.

## The checklist, offline

`outboundGatewayChecklist` (`@agboss/core/testing`) probes G1–G5 through your adapter and returns
one result per requirement, with its evidence. Against `FakeOutboundGateway` it runs offline in a
test; against your gateway's sandbox you run it by hand. G6 needs the gateway's own events and is
not probed.

<!-- snippet-context
import { expect, it } from "vitest";
// @snippet
-->

```ts
import {
  FakeOutboundGateway,
  GatewayCheckStatus,
  outboundGatewayChecklist,
  VirtualClock,
} from "@agboss/core/testing";

it("our gateway's capabilities, as the checklist sees them", async () => {
  const clock = new VirtualClock();
  // a gateway without a lookup by key: switch off what yours lacks
  const gateway = new FakeOutboundGateway({ clock, capabilities: { lookupByKey: false } });

  const report = await outboundGatewayChecklist({
    send: (charge) => gateway.charge(charge), // your adapter: amount + idempotencyKey → receipt
    clock, // moves the gateway's time for G3; without it G3 is skipped
  });

  const lookup = report.results.find((result) => result.requirement === "G2");
  expect(lookup?.status).toBe(GatewayCheckStatus.Failed);
  expect(lookup?.evidence).toMatch(/reconciliation cannot work/);
});
```

- **`FakeOutboundGateway({ clock, capabilities })`:** `idempotencyKeys` (G1), `keyRetention` (G3,
  on the clock), `lookupByKey` (G2), `firstResponseOnRepeat` (G4), `conflictOnMismatch` (G5), all
  on by default (`FULL_GATEWAY_CAPABILITIES`, keys kept a day). `charge({ amount, idempotencyKey })`,
  `lookup(idempotencyKey)`, `payments` (every payment made: where a double charge shows).
- **Faults:** `injectFault(FakeGatewayFault.AnswerThenDrop)` (processed, and the caller sees a
  timeout), `FailBeforeProcessing` (nothing processed), `Slow` (`{ delay }` on the clock);
  `{ times }` for several charges. `FakeGatewayError` with `kind: FakeGatewayErrorKind`.
- **The report:** `results` in order G1–G5, each `{ requirement, status: GatewayCheckStatus.Passed |
  Failed | Skipped, evidence }`, and `isPassed` (nothing failed). A probe the gateway fails is that
  requirement's failure, with the error as evidence. Against a sandbox, give `keyPrefix` a value of
  its own per run, and `requiredRetention` your longest recovery (default `hours(24)`).
