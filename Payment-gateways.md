# Payment gateways

A charge is a call that leaves the system ([Several instances](Several-instances#calls-that-leave-the-system-505)).
AGBoss records an intent before every such call, and reconciles one left pending instead of sending
it again blindly. Whether a customer can be charged twice depends on what the gateway supports. This
page lists those requirements, what AGBoss guarantees with and without each, what ten widely used
gateways document and whether each is supported, and a checklist a team runs against its own
gateway. It is part of the [Payments](Payments) section, with the races and failures on
[Payment scenarios](Payment-scenarios).

Gateways are named only to identify their public APIs: these are independent notes, not affiliated
with or endorsed by any of them ([the notice](Payments#the-notice)).

## The requirements

| # | Requirement | What AGBoss gives with it | Without it |
| --- | --- | --- | --- |
| G1 | Accepts a client idempotency key per request | A resend after `notSent()` or a definite failure (the same key) is deduplicated by the gateway | A crash after sending can charge twice; only `reconcile` with G2 prevents it |
| G2 | Finds a payment by that key, or by a client reference you set | `reconcile` asks what happened: never a blind resend | An unknown outcome stays `unknown`: `OutboundCallUnreconciledError`, a person decides |
| G3 | Keeps keys at least as long as the longest recovery: the lease (30 s), the sweep (30 s), a pause or an operator's retry, stated in days | Replays inside the window are safe; declared as the call's `keyRetention`, a replay past it is refused (#658) | A late replay after the window is a new charge — unless `keyRetention` refuses it |
| G4 | Returns the first response on a repeat | A repeat carries the real receipt | A repeat cannot be told from a new charge |
| G5 | Refuses the same key with other parameters | A bug or a tampered request is caught at the gateway too | Only AGBoss's own check catches it (a business key's fingerprint, #508) |
| G6 | Tells late outcomes: a status API or webhooks | `unknown` turns into a decision later | Pending intents need manual review |

## Can I be charged twice?

| The gateway supports | A crash before the answer | A provider error, then a retry | A late replay (days later) |
| --- | --- | --- | --- |
| G1 + G2 + G3 | No: `reconcile` finds the payment by its key | No: an error of unknown outcome is reconciled first (#657); a definite one moved no money | No: `reconcile` finds it by a reference that does not expire |
| G1 + G3, no G2 | No while the key lives, if you make `reconcile` answer `notSent()` and rely on G1 to deduplicate, and declare `keyRetention`; with `unknown()`, a person decides | No, the same way | No: past `keyRetention` the replay is refused, a person decides (#658) |
| G2, no G1 | No: `reconcile` finds it, if it looks the payment up by your reference | No: the error is of unknown outcome unless you mark it definite, so `reconcile` decides (#657) | No while `reconcile` still finds it by your reference; **yes** once the gateway no longer finds it |
| Neither | **Yes**: nothing can tell what happened; `reconcile` can only answer `unknown` | **Yes** | **Yes** |

Rules that follow:

- **Mark an error definite only when the gateway says nothing was charged (#657).** An error
  `send` throws is of unknown outcome by default: the intent stays `Pending`, and the next attempt
  asks `reconcile` before anything is sent again. Return `true` from `isDefiniteFailure(error)`
  only for an answer the gateway documents as final and money-free: a request refused by its
  validation (a 400 naming a parameter), a card decline (Stripe's 402 `card_error`). Never for a
  5xx (Stripe saves even a 500 under the key; Checkout.com saves no 4xx or 5xx, so a repeat runs
  again), a 409 "a request with this key is in progress", a 429, a reset connection, a DNS failure
  or the SDK's own timeout, which come after or regardless of the gateway acting. When in doubt,
  leave it out: an unknown error costs one lookup, a wrong "definite" can cost a second charge.
- **Declare the key's retention when `notSent()` relies on a replay (#658).** `reconcile` gets
  `lookup.attemptStartedAt` and `lookup.keyAge` (the store's clock). If your `notSent()` means
  "send it again under the key and let the gateway replay the first answer" — a gateway with no
  lookup, or a search that lags —, set `keyRetention` to the gateway's documented minimum (Stripe
  `hours(24)`, Checkout.com `hours(72)`, Adyen `hours(168)`): past it the framework sends nothing
  and fails the step with `OutboundCallUnreconciledError` for a person. A lookup that proves a
  payment never arrived needs no `keyRetention`.
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
  Adyen takes 64 characters, Square 45, CardCom 25 — gets a fixed-length digest of it from your
  adapter, such as its SHA-256 in base64url (43 characters; for CardCom its first 25, 150 bits):
  the same call always sends the same key and two calls never share one. A key cut short can make two orders one payment ([#532](https://github.com/agbossjs/agboss/issues/532)).
- **Make the business key once, in one form.** Two texts that look the same are two keys to
  AGBoss and to the gateway: a key with a zero-width space, a bidi control or "e" + U+0301 would be
  a second charge of one order, and so would `" order-1"`, `"order-1 "`, `"order  1"` or a
  no-break space in it. AGBoss refuses them (#538: control and format characters, lone surrogates,
  non-NFC text; #547: a space other than U+0020 or a line or paragraph separator, and a U+0020 at
  an edge or doubled; #556: a character that renders as nothing — a variation selector, so an
  emoji with U+FE0F too, a Hangul filler, the combining grapheme joiner —, private use, a
  noncharacter, an unassigned code point, the braille blank U+2800 — `InvalidBusinessKeyError`
  naming the rule), so normalize an imported
  identifier where it enters your system (`text.normalize("NFC")`, invisible characters stripped,
  spaces trimmed, collapsed and made U+0020) and never fold case or width afterwards
  ([Several instances](Several-instances#business-idempotency-keys-508)).
- **Look up by key, not by the request.** `reconcile` gets the request as stored, masked by the PII
  policies; `lookup.idempotencyKey` is what the gateway knows the call by.
- **Keep keys longer than your longest recovery.** A paused execution answered tomorrow replays
  its step tomorrow.

## The ten gateways

Read on **2026-11-01**, from each gateway's official public documentation, its own GitHub
organisation and its npm package only (#653). A cell says "not documented" when the docs did not
say it. These are independent notes, not affiliated with or endorsed by any gateway
([Payments](Payments#the-notice)), and gateways change their APIs: check the linked page before you
rely on a row.

**The support rule.** A gateway is supported when its public docs show:

1. an idempotency key (G1) on every money-moving operation the example uses; and
2. a way to learn the outcome of a request whose answer was lost (G2). That is a read by a key, a
   reference or an id the application holds before money moves, or a replay of the same key
   inside a **documented** retention window. With only the replay, support is bounded by that
   window: past it, `reconcile` answers `unknown`.

A duplicate check that refuses a repeat, with no documented machine-readable answer, is not a key.
A gateway whose API docs are not public is not supported.

| Gateway | Verdict | Why | Its docs | Example |
| --- | --- | --- | --- | --- |
| **Stripe** | **Supported** | A key on every POST, kept at least 24 h; a repeat replays the first answer; changed parameters are refused; a lookup by your `metadata` and by id | [idempotent requests](https://docs.stripe.com/api/idempotent_requests), [low-level errors](https://docs.stripe.com/error-low-level#idempotency), [search](https://docs.stripe.com/api/payment_intents/search) | [`stripe`](https://github.com/agbossjs/agboss-examples/tree/main/12-payment-gateways/src/gateways/stripe) |
| **Adyen** | **Supported, for 7 days** | A key on every POST, kept 7 to 14 days, a repeat answered with the first response; no read API for payments, so after 7 days an unknown outcome stays unknown; captures and refunds end by webhook | [API idempotency](https://docs.adyen.com/development-resources/api-idempotency), [Checkout API v72](https://docs.adyen.com/api-explorer/Checkout/72/overview) | [`adyen`](https://github.com/agbossjs/agboss-examples/tree/main/12-payment-gateways/src/gateways/adyen) |
| **PayPal** | **Supported** | `PayPal-Request-Id` on create order, authorize, capture, void and refund; the order id exists before money moves, and the order's GET shows its captures and refunds | [idempotency](https://developer.paypal.com/api/rest/reference/idempotency/), [Orders v2](https://developer.paypal.com/docs/api/orders/v2/) | [`paypal`](https://github.com/agbossjs/agboss-examples/tree/main/12-payment-gateways/src/gateways/paypal) |
| **Braintree** | **Not supported** | The server API reference documents no idempotency key; its key appears only in SDK changelogs and source. Duplicate Transaction Checking refuses a repeat (30 s by default, can be switched off) instead of replaying it | [transaction.sale](https://developer.paypal.com/braintree/docs/reference/request/transaction/sale/node), [duplicate checking](https://developer.paypal.com/braintree/articles/control-panel/transactions/duplicate-checking) | none |
| **Checkout.com** | **Supported** | `Cko-Idempotency-Key` on payments, captures, refunds and voids, kept 72 h; a repeat replays a 2xx answer; a lookup by your `reference` and by id | [idempotency](https://www.checkout.com/docs/developer-resources/api/idempotency), [list payments](https://www.checkout.com/docs/payments/manage-payments/get-a-list-of-payments) | [`checkout-com`](https://github.com/agbossjs/agboss-examples/tree/main/12-payment-gateways/src/gateways/checkout-com) |
| **Square** | **Not supported** | A key on create and refund, with a conflict on changed parameters, but no lookup by the key or by `reference_id`, and no stated retention, so a replay cannot stand in for a lookup; capture and void take no key | [create payment](https://developer.squareup.com/reference/square/payments-api/create-payment), [list payments](https://developer.squareup.com/reference/square/payments-api/list-payments), [idempotency](https://developer.squareup.com/docs/build-basics/common-api-patterns/idempotency) | none |
| **Tranzila** | **Not supported** | Its duplicate check (`DCdisable`) is documented for sales only, for 24 h, is skipped after a failed first attempt, needs a terminal setting, and answers a repeat with a message for the customer: no replay and no documented error code | [Tranzila API](https://docs.tranzila.com/docs/payments-and-billing/tranzila-api) | none |
| **CardCom** | **Supported, for charges** | `ExternalUniqTranId` on Do Transaction (a token charge, a direct charge, a J5 capture) replays the original answer, and `GetTransactionByExternalUniqTran` finds it. Refunds and the hosted payment page take no key: a refund whose answer is lost stays unknown | [API v11](https://secure.cardcom.solutions/api/v11/docs), [preventing duplicates (Hebrew)](https://kb.cardcom.solutions/apijosn/he/articles/509/prevent-duplicate-token-transactions) | [`cardcom`](https://github.com/agbossjs/agboss-examples/tree/main/12-payment-gateways/src/gateways/cardcom) |
| **Grow** (formerly Meshulam) | **Not supported** | `transactionUniqueIdentifier` (token charges only) refuses a reused id "regardless of the status of the first request", with no documented error code; the lookup's answer is not documented; refunds, captures and the hosted page take no key | [create transaction with token](https://developers.grow.business/reference/create-transaction-with-token) | none |
| **PayPlus** | **Not supported** | No idempotency key on any money-moving call; `more_info` is stored, not enforced unique | [transactions view](https://docs.payplus.co.il/reference/post_transactions-view) | none |

### What each gateway documents

| Gateway | G1 key | G2 lookup | G3 retention | G4 first response | G5 conflict | G6 late outcomes | Official Node SDK, pointed at a stub |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Stripe** | `Idempotency-Key` header, every v1 POST, up to 255 characters | `metadata` search, which lags ("Don't use search in read-after-write flows"); retrieve by id; refunds listed per payment | at least 24 h | yes, the saved status and body, 500s included; `Idempotent-Replayed: true` | yes, `idempotency_error` | webhooks (HMAC-SHA256, may repeat, no order) and retrieve | `stripe`: `host`, `port`, `protocol` |
| **Adyen** | `idempotency-key` header, every POST, up to 64 characters | the key's replay only; no GET for payments in Checkout v72 | 7 to 14 days | yes, the first response | not documented | webhooks (HMAC, may repeat, order by timestamp); no status API | `@adyen/api-library`: no host option; a custom `httpClient` (README) |
| **PayPal** | `PayPal-Request-Id` header on create order, authorize, capture, void, refund | GET by the PayPal order id you hold; no lookup by `invoice_id` | Orders: 6 h, in PayPal's GitHub spec and its SDK only; Payments v2: not documented | partly: the **current** status, not the original response | not documented | webhooks (certificate signature, retried for 3 days) and GET | `@paypal/paypal-server-sdk`: no base URL option (production and sandbox only) |
| **Braintree** | not in the API reference | `transaction.search` by `orderId`, `transaction.find` | not documented | not documented | not documented | webhooks (signed, retried, "may not be delivered sequentially") | `braintree`: a custom `Environment` (source) |
| **Checkout.com** | `Cko-Idempotency-Key` header on payments, captures, refunds, voids | `GET /payments?reference=` (not unique, up to 1000 records), `GET /payments/{id}` | 72 h | yes, for a 2xx answer only | not documented for payments | webhooks (HMAC, "at least once", order "may vary") and GET | `checkout-sdk-node`: `host` |
| **Square** | `idempotency_key` in the body, up to 45 characters, on create, refund, update | none by key or reference; `GetPayment` by id | not documented | yes, `200` with the existing resource | yes, `400 IDEMPOTENCY_KEY_REUSED` | webhooks (HMAC-SHA256, may repeat, no order) and GET | `square`: `baseUrl` (source) |
| **Tranzila** | `DCdisable`, sales only as documented | the reports API by a user field and a date range | 24 h | no: refused with a message | not documented | a notify URL, signing not documented | none; HTTP `https://api.tranzila.com/v1` |
| **CardCom** | `ExternalUniqTranId` in the body, up to 25 characters, on Do Transaction | `GetTransactionByExternalUniqTran` | not documented ("valid until" a successful answer) | yes, with `ExternalUniqUniqTranIdResponse: true` (else error 608) | not documented | webhooks, **unsigned** (re-query `GetLpResult`), retried 7 times | none; HTTP `https://secure.cardcom.solutions/api/v11` |
| **Grow** | `transactionUniqueIdentifier` on token charges | `getTokenTransactionsByExternalIdentifiers` (its answer not documented) | not documented | no: refused | refused, code not documented | a server callback, signing not documented | none; HTTP `https://secure.meshulam.co.il/api/light/server/1.0/` |
| **PayPlus** | none | `/Transactions/View` by `more_info` | — | — | — | a callback (HMAC-SHA256 `hash` header) | none; HTTP `https://restapi.payplus.co.il/api/v1.0/` |

### Quotes the verdicts rest on

All read 2026-11-01.

- **Stripe.** "For API v1, all `POST` requests accept idempotency keys." "Stripe retains keys for at
  least 24 hours and can remove them after that. Reusing a key after it's removed can execute a new
  request." "Retries with the same key return the saved response, including `500` errors." "The
  idempotency layer compares incoming parameters to those of the original request and errors if
  they're not the same." ([idempotent requests](https://docs.stripe.com/api/idempotent_requests),
  [low-level errors](https://docs.stripe.com/error-low-level#idempotency))
- **Adyen.** "Idempotency keys are valid for a period of 7 to 14 days after first submission." "If
  the Adyen payments platform already processed the request, the response to the first attempt will
  be returned without duplication." Its Checkout API v72 lists no GET for a payment
  ([API idempotency](https://docs.adyen.com/development-resources/api-idempotency),
  [Checkout API v72](https://docs.adyen.com/api-explorer/Checkout/72/overview)). The same page says
  to fall back to sending no key when its idempotency store is down (error 703): never do that
  with AGBoss.
- **PayPal.** "PayPal returns the latest status of the previous request that used that same
  header." "PayPal provides the status of a request at the current time and not the status of the
  original request." ([idempotency](https://developer.paypal.com/api/rest/reference/idempotency/))
- **Braintree.** The [`transaction.sale` reference](https://developer.paypal.com/braintree/docs/reference/request/transaction/sale/node)
  names no idempotency parameter. Duplicate checking: suspected duplicates "will be Gateway
  Rejected", the window "set to 30 seconds by default"
  ([duplicate checking](https://developer.paypal.com/braintree/articles/control-panel/transactions/duplicate-checking)).
- **Checkout.com.** Keys expire "after 72 hours for both the sandbox and production
  environments"; repeats "return the same HTTP status code and response body as the original
  request"; for a 4xx or 5xx original "we don't save an idempotent result"
  ([idempotency](https://www.checkout.com/docs/developer-resources/api/idempotency)). The list's
  `reference` is "The payment reference to search for"
  ([list payments](https://www.checkout.com/docs/payments/manage-payments/get-a-list-of-payments)).
- **Square.** "If you retry the call using the same idempotency key and change any of the request
  details, you get a `400 Bad Request`" ([using the REST API](https://developer.squareup.com/docs/build-basics/general-considerations/using-rest-api)).
  List payments filters by time, location, amount and card, not by `reference_id` or the key
  ([list payments](https://developer.squareup.com/reference/square/payments-api/list-payments)).
- **Tranzila.** "If it is detected that the unique value in DCdisable has already been used once,
  no additional charge will be made." "The check in our DB will be performed up to 24 hours back."
  "If a transaction fails the first time, no check will be performed for it on DCdisable."
  ([Tranzila API](https://docs.tranzila.com/docs/payments-and-billing/tranzila-api))
- **CardCom.** On `ExternalUniqUniqTranIdResponse`: "true - לא יחייב את הכרטיס, אבל יחזיר את
  התגובה המקורית של העסקה" ("true: it will not charge the card, but returns the original response
  of the transaction") ([Do Transaction (Hebrew)](https://kb.cardcom.solutions/apijosn/he/articles/508/do-transaction-token-charge-direct-interface)).
  Parallel requests: wait for the answer before resending, "בדרך כלל ... 1 שניה , אבל יכול לקחת עד
  7 שניות" ("usually 1 second, but can take up to 7 seconds")
  ([preventing duplicates (Hebrew)](https://kb.cardcom.solutions/apijosn/he/articles/509/prevent-duplicate-token-transactions)).
- **Grow.** "If it finds that a request has been sent with this ID, then the current request will
  be rejected outright regardless of the status of the first request with this ID."
  ([create transaction with token](https://developers.grow.business/reference/create-transaction-with-token))
- **PayPlus.** `more_info`: "Additional search criteria to find transactions based on extra info";
  no charge or refund request names a unique or idempotency field
  ([transactions view](https://docs.payplus.co.il/reference/post_transactions-view)).

### What it means

- **Stripe:** reconcile by your own reference in `metadata`. The search lags, so an empty search
  is not "not sent": inside the 24 h a replay under the same key is the safe answer (`notSent()`
  sends it again, and Stripe returns the first payment); later, `unknown`.
- **Adyen:** no read API. Inside 7 days, `notSent()` replays the key and gets the first response.
  Past that, `unknown`. A capture's or refund's answer only says it was received: its outcome is a
  webhook, stored by your code.
- **Both:** declare the key's retention (`keyRetention: hours(24)` for Stripe, `hours(168)` for
  Adyen, #658). A `notSent()` that replays the key is then sent only while the key is younger than
  that by `attemptTimeout`; later, nothing is sent and a person decides. `lookup.keyAge` tells a
  `reconcile` of its own the same age, on the store's clock.
- **PayPal:** money moves at the capture (or authorize), never at the order's creation. Keep the
  order id the first call returned, and reconcile a capture by the order's GET. A repeat returns
  the current status, not the first answer.
- **Checkout.com:** reconcile by `reference`, set to the order. The reference is not unique, so
  match the reference, the amount and the currency of every hit. A 4xx or 5xx is not saved under the key: a repeat runs again — so a 5xx is never
  `isDefiniteFailure` (#657): it stays pending and is reconciled by `reference`.
- **CardCom:** charges only. Send `ExternalUniqUniqTranIdResponse: true` and a 25-character key,
  and reconcile by `GetTransactionByExternalUniqTran`. A refund is not keyed by the gateway:
  AGBoss never sends it twice itself, but one whose answer is lost is `unknown`, for a person.
  Webhooks are unsigned: re-query before trusting one.

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
