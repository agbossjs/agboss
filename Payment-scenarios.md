# Payment scenarios

Every way we know to charge or refund a customer twice, or to lose a payment, and what AGBoss does
in each (#653). For each scenario, five things:

- **Wrong:** what goes wrong without protection. The full example does exactly this.
- **AGBoss:** the mechanism that stops it.
- **Guarantee:** the guarantee it rests on, `P1`–`P5` of [Guarantees](Guarantees), with the
  assumptions (`A1`–`A12`) it needs. When an assumption does not hold, the guarantee does not
  either.
- **Boundary:** where the framework's job ends and the gateway's (`G1`–`G6`,
  [Payment gateways](Payment-gateways)) or the application's begins.
- **Proof:** the core test or fault scenario that proves AGBoss's side
  ([Guarantees across processes](Guarantees-across-processes)), and the scenario's id in the full
  example.

This page claims nothing beyond [Guarantees](Guarantees). Where a scenario has no proof in the
core, it says so. Gateways are named only to identify their public APIs: these are independent
notes, not affiliated with or endorsed by any of them ([the notice](Payments#the-notice)).

The mechanisms, by their short names:

| Name | What it is | Where |
| --- | --- | --- |
| **Fenced effect** | A write to the store's own database, once per key, refused for a superseded lease in the same transaction | [Several instances](Several-instances#the-fenced-effect-500) |
| **Business key** | A fenced effect or outbound call keyed by what it is about (`order:42`), not by the step | [Several instances](Several-instances#business-idempotency-keys-508) |
| **Outbound call** | An intent recorded before a call to another system, settled after it, reconciled when left pending | [Several instances](Several-instances#calls-that-leave-the-system-505) |
| **Lease and fence** | One owner per execution tree; a holder past its lease writes and sends nothing | [Several instances](Several-instances#the-execution-lease) |
| **Undo once** | An automatic undo is marked done and never runs again | [Guarantees across processes](Guarantees-across-processes#what-is-left-to-the-application-and-to-downstream-systems) |
| **Pause answered once** | A pause goes from pending to resolved once; a second answer is refused | [Pauses](Pauses#concurrent-answers) |

## Summary

| ID | Scenario | AGBoss mechanism | Left to |
| --- | --- | --- | --- |
| [PS1](#ps1-a-retry-after-a-timeout) | A retry after a timeout | Outbound call | Gateway: G1–G3 |
| [PS2](#ps2-a-crash-after-the-charge-before-the-checkpoint) | A crash after the charge, before the checkpoint | Fenced effect, outbound call | Application: calls outside them |
| [PS3](#ps3-a-zombie-after-a-takeover) | A zombie after a takeover | Lease and fence | Gateway: G1, for a request already on the wire |
| [PS4](#ps4-the-zombie-reaches-the-write-first) | The zombie reaches the write first | Lease and fence | — |
| [PS5](#ps5-a-crash-after-the-send-before-the-answer) | A crash after the send, before the answer | Outbound call | Gateway: G2 |
| [PS6](#ps6-support-levels-full-no-lookup-no-keys) | Support levels: full, no lookup, no keys | Outbound call | Gateway: G1–G6 |
| [PS7](#ps7-the-model-calls-the-charge-tool-twice) | The model calls the charge tool twice | Business key | Application: where the key comes from |
| [PS8](#ps8-two-executions-for-one-order) | Two executions for one order | Business key | Application: the in-flight answer |
| [PS9](#ps9-parallel-branches-charging-one-aggregate) | Parallel branches charging one aggregate | Business key, fenced effect | Application: the aggregate's invariant |
| [PS10](#ps10-a-saga-a-charge-and-its-refund-each-replayed-or-interrupted) | A saga: a charge and its refund, replayed or interrupted | Undo once, outbound call | Application: refund through the outbound call |
| [PS11](#ps11-a-pause-answered-twice) | A pause answered twice | Pause answered once | Application: one pause per payment |
| [PS12](#ps12-a-rolling-deploy-or-a-graceful-stop-mid-payment) | A rolling deploy or a graceful stop mid-payment | Lease and fence, recovery | Application: stable keys across versions |
| [PS13](#ps13-clock-skew-and-lease-expiry) | Clock skew and lease expiry | Lease and fence | Platform: A3–A5 |
| [PS14](#ps14-the-database-lost-mid-commit) | The database lost mid-commit | Fenced effect, outbound call | — |
| [PS15](#ps15-a-webhook-delivered-twice) | A webhook delivered twice | Business key, pause answered once | Application: signature check |
| [PS16](#ps16-webhooks-out-of-order) | Webhooks out of order | — | Application |
| [PS17](#ps17-the-idempotency-key-expires-before-a-retry) | The idempotency key expires before a retry | Outbound call, retention | Gateway: G3; application: the order row |
| [PS18](#ps18-a-partial-capture) | A partial capture | Business key | Gateway: over-capture |
| [PS19](#ps19-a-refund-retried) | A refund retried | Business key, outbound call | Application: one key for every refund path |
| [PS20](#ps20-a-void-and-a-capture-race-on-one-authorization) | A void and a capture race | Business key | Gateway: its state machine |
| [PS21](#ps21-a-redirect-or-3ds-flow-the-browser-retries) | A redirect or 3DS flow: the browser retries | Business key, pause answered once | Application: read the outcome from the gateway |
| [PS22](#ps22-a-retry-with-another-card-after-a-decline) | A retry with another card after a decline | Business key | Application: numbering attempts |
| [PS23](#ps23-two-requests-under-one-key-at-once) | Two requests under one key at once | Outbound call | Gateway: in-flight duplicates |

## Failures of the process

### PS1. A retry after a timeout

The gateway charged, but the answer was lost.

- **Wrong:** the step retries with a new idempotency key, or with none: two charges.
- **AGBoss:** the charge is an outbound call. There are two cases:
  - **The step's signal aborts the wait** (its timeout, a lost lease, a cancel). The intent stays
    pending, and the next attempt calls `reconcile`, which looks the payment up (G2) before
    anything is sent again.
  - **The SDK throws.** The intent is recorded `Failed`, and the next attempt sends it again under
    the same `call.idempotencyKey`. The gateway answers with the first payment (G1, G4).
- **Guarantee:** P3. Assumptions: A6, and A7 (the gateway's G1–G3).
- **Boundary:** a `Failed` intent is sent again without `reconcile`. So when the SDK's error did
  not mean "nothing happened" (a 5xx after the gateway processed it, a reset connection, the SDK's
  own timeout), the resend is safe only while the gateway still keeps the key (G3). Past it, the
  resend is a second charge. Tracked in [#657](https://github.com/agbossjs/agboss/issues/657) (0.1.1).
- **Proof:** `s09-crash-after-send`; the outbound-call protocol tests. Full example: `ps1`.

### PS2. A crash after the charge, before the checkpoint

The step's effect is done, but its checkpoint was not written, so the step runs again.

- **Wrong:** a plain HTTP call or database write in the step: it happens twice.
- **AGBoss:** a fenced effect finds its key and returns the stored result (`Replayed`). An outbound
  call finds its intent `Completed` and returns the stored receipt. Nothing is sent again.
- **Guarantee:** P2, P3. Assumptions: A1, A2, A11.
- **Boundary:** a side effect outside a fenced effect or an outbound call happens **at least once**.
- **Proof:** `s03-crash-after-charge`, `s03b-crash-after-payment`. Full example: `ps2`.

### PS3. A zombie after a takeover

A pod freezes (a GC pause, `SIGSTOP`, a VM migration). Its lease expires, and another pod takes the
tree over and charges. Then the frozen pod wakes up and charges too.

- **Wrong:** a write or a call that checks no fence: two charges.
- **AGBoss:** every fenced write checks the lease in the write's own transaction, so a superseded
  token is refused (`ExecutionFencedError`, a hand-over). Before an outbound call is sent, the
  lease is renewed (`confirmNow()`) and checked on the holder's monotonic clock (`assertHeld()`),
  with nothing awaited in between.
- **Guarantee:** P1, P3. Assumptions: A2–A6.
- **Boundary:** a request already on the wire when the pod froze can arrive after the new holder's.
  Only the gateway's key (G1) makes it one payment (A6).
- **Proof:** `s05-zombie-write-refused`, `s05d-zombie-recorded-not-sent`, `s04-lease-expires`. Full
  example: `ps3`.

### PS4. The zombie reaches the write first

The same zombie, but its write reaches the store **before** the new holder's.

- **Wrong:** a store that reads the lease, then writes in another round trip: the zombie's write
  goes in, the new holder replays it, and the zombie's result wins.
- **AGBoss:** the fenced-effect and outbound-call stores check the lease row in the write's own
  transaction (`LeaseCheck.Atomic`, on the lease store's backend). A store that opts out
  (`LeaseCheck.WithoutDoubleChargeProtection`) must never back payments.
- **Guarantee:** P1–P3. Assumptions: A1, A2.
- **Boundary:** none on AGBoss's side; your own store must pass `storeConformance` and `faultSuite`
  ([Your own store](Your-own-store)).
- **Proof:** `s05b-zombie-reaches-charge-first`, `s05c-zombie-reaches-payment-first`, and their
  sabotage runs. Full example: `ps4`.

### PS5. A crash after the send, before the answer

The pod dies after the request left and before the answer came back. Nobody knows whether the
customer was charged.

- **Wrong:** the recovered step sends again.
- **AGBoss:** the intent is still pending, so the next holder calls `reconcile(lookup)` with the
  call's key. The answer is one of:
  - `completed(result)`: the payment exists, nothing is sent (`Reconciled`);
  - `notSent()`: it never arrived, so it is sent once more under the same key;
  - `unknown({ reason })`: `OutboundCallUnreconciledError`, nothing sent, the intent left for an
    operator (`app.pendingOutboundCalls`).
- **Guarantee:** P3. Assumption: A7 (G2, or G6).
- **Boundary:** without a lookup (G2), `reconcile` can only say `unknown`, and a person decides.
- **Proof:** `s09-crash-after-send`, `s10-one-order-two-executions`. Full example: `ps5`.

### PS6. Support levels: full, no lookup, no keys

What the same failures do on gateways that offer less. The full example runs every scenario on
three stub gateways:

| Level | The stub offers | PS1 timeout | PS5 crash before the answer | A late replay |
| --- | --- | --- | --- | --- |
| **Full** | keys (G1), lookup (G2), retention (G3), first response (G4), conflict (G5), status (G6) | one charge | one charge (`Reconciled`) | one charge inside G3 |
| **No lookup** | keys, no lookup | one charge when the SDK threw (G1); `unknown` when the wait was aborted | `unknown`: a person decides, or `notSent()` relying on G1 while the key lives | a new charge after G3 |
| **No keys** | neither | **two charges** | `unknown` only | **two charges** |

- **Guarantee:** P3, through A7.
- **Boundary:** a gateway without keys or without a lookup is **not supported**
  ([Payment gateways](Payment-gateways#the-ten-gateways)).
- **Proof:** `outboundGatewayChecklist` against `FakeOutboundGateway` at each level. Full example:
  `ps6`.

### PS12. A rolling deploy or a graceful stop mid-payment

A pod gets `SIGTERM` while a charge is in flight, and the tree is continued on a pod running the new
version.

- **Wrong:** the new version names the effect differently, or builds the business key in another
  format: the same order gets a new key, and is charged again.
- **AGBoss:**
  - A stopping pod waits for its running step bodies. It releases a tree's lease only once they
    returned, so no other pod reruns a step that is still running here (#367).
  - Recovery continues a tree only on a version whose config hash matches, unless the workflow's
    `onIncompatibleResume` says `"resume"`.
  - A changed request shape under the same business key is a different fingerprint:
    `IdempotencyKeyConflictError`, refused, never charged.
- **Guarantee:** P1, P3. Assumptions: A1, A6.
- **Boundary:** while intents are in flight, keep three things the same across versions: the
  business key's text, the effect's name and the request the fingerprint is made of. Set
  `shutdownTimeout` below the platform's grace period.
- **Proof:** `s01-sigterm-drains`, `s01b-sigterm-shorter-than-step`, `s11-short-grace`,
  `s11b-shutdown-timeout-above-grace`. Full example: `ps12`.

### PS13. Clock skew and lease expiry

One pod's clock runs ahead or behind the others.

- **Wrong:** expiry decided on the caller's clock: a pod ahead takes a live lease, and both pods
  charge.
- **AGBoss:** the store decides expiry by its own time (the database's clock). The holder counts
  down its lease from when it sent the request, on its monotonic clock and its wall clock at once,
  minus a 1 s margin.
- **Guarantee:** P1, P3. Assumptions: A3 (the database's clock is slewed, never stepped), A4 (drift
  ≤ 1 s per 30 s), A5 (no pause that stops both of the holder's clocks).
- **Boundary:** a stepped database clock (a failover to a replica whose clock differs) breaks P1's
  "one holder trusts the lease"; fenced writes are still refused (A2), and a send already decided
  rests on G1.
- **Proof:** `s13-clock-ahead`, `s13-clock-behind`, `lease-skew-charge.test.ts`. Full example:
  `ps13`.

### PS14. The database lost mid-commit

The connection drops while a write commits. The pod does not know whether it committed.

- **Wrong:** "the write failed, so charge again".
- **AGBoss:**
  - A fenced effect commits or rolls back as one transaction. Run again, it finds its key
    (`Replayed`) or runs once.
  - When an outbound call's completion may not have committed, its intent may still be pending,
    and the next attempt reconciles it.
  - A pod that cannot renew its lease stops and writes nothing.
- **Guarantee:** P1–P3. Assumptions: A1, A2.
- **Boundary:** none on AGBoss's side.
- **Proof:** `s08-database-cut`, `s08b-database-back-after-expiry`. Full example: `ps14`.

## Duplicates the application makes

### PS7. The model calls the charge tool twice

One agent loop calls the charge tool twice, or two visits of the agent each call it. These are two
tool calls with two step keys.

- **Wrong:** the charge keyed by its step (`fencedEffectKeyOf(executionContext, "charge")`): two
  charges.
- **AGBoss:** a business key, `fencedEffectKeyOf(executionContext, "charge", { businessKey:
  \`order:${orderId}\` })`. The second call gets the first's receipt (`Replayed`; `Joined` while the
  first is still sending on this instance). A call for the same order with another amount is
  `IdempotencyKeyConflictError`, and nothing is sent.
- **Guarantee:** P2, P3. Assumption: A8 (one `pseudonymKey` on every instance).
- **Boundary:** make the business key from the order the execution works on, never from text the
  model wrote. An approval (a pause) or a tool interceptor can stop a charge the model should not
  make; the key only makes it once.
- **Proof:** the business-key tests of the core (Several instances → Business idempotency keys).
  Full example: `ps7`.

### PS8. Two executions for one order

A double click, an HTTP request retried by a proxy, two threads of one customer.

- **Wrong:** a step-keyed charge in each execution: two charges.
- **AGBoss:** the same business key in both. The second finds the first's intent:
  - completed: the first's receipt (`Replayed`, with `replayedFrom` naming who made it);
  - pending under a lease still live on another pod: `OutboundCallInFlightError`, nothing sent;
  - pending under a lease that ended: it reconciles, and only the winner of the compare-and-set
    sends.
- **Guarantee:** P2, P3. Assumptions: A1, A8.
- **Boundary:** route `OutboundCallInFlightError` to an answer like "payment in progress". Never
  route it to a new charge.
- **Proof:** `s10-one-order-two-executions`. Full example: `ps8`.

### PS9. Parallel branches charging one aggregate

Parallel branches, or `ChildPlacement.AnyInstance` children, charge one customer or draw on one
balance.

- **Wrong:** each branch charges by its own step key: the same charge made twice, or two charges
  that together exceed the balance.
- **AGBoss:**
  - The same charge made by two branches: one business key, so one charge.
  - Two distinct charges against one balance: the business row's own constraint, checked inside
    the fenced effect's transaction (A11), refuses the one that would exceed it.
  - Each branch's fence is its own (`fence.scopeKey`); key no fencing mark by a shared business
    row.
- **Guarantee:** P2. Assumption: A11.
- **Boundary:** the aggregate's invariant (a balance, a limit) is the application's: "a shared
  aggregate needs its own locking" (Several instances → Fencing external writes).
- **Proof:** none in the core for the aggregate's invariant; the fenced effect's contract cases.
  Full example: `ps9`.

### PS10. A saga: a charge and its refund, each replayed or interrupted

A later step fails, so the charge's undo refunds it. A pod dies or freezes during the charge or
during the refund.

- **Wrong:** the refund is a plain call in the undo action: a pod that dies after the refund and
  before the undo is marked done refunds again.
- **AGBoss:**
  - A crash is a hand-over, never a failure: nothing is undone (P5).
  - An undo marked done never runs again on any pod (#607).
  - An undo's own key is `<step key>:compensation`: put the refund behind an outbound call under
    it, or under a business key.
- **Guarantee:** P5, P3. Assumptions: A1, A2.
- **Boundary:** between the refund's effect and the undo's done mark, the undo runs again under the
  same key. So it is exactly once only when the refund itself is fenced (an outbound call or a
  fenced effect). A holder frozen **inside** the undo action, past its lease, goes on running your
  code there; only a fenced refund is refused then (#640).
- **Proof:** `s12-real-failure-undone-once`, `s12b-marked-undo-not-again`,
  `undo-once.matrix.test.ts`. Full example: `ps10`.

### PS11. A pause answered twice

Two approvers press "approve" on one payment at once, or a webhook and an operator answer the same
pause.

- **Wrong:** the caller stores the approval and acts on each call.
- **AGBoss:** a resume first moves the pause from `Pending` to `Resolved` atomically. The second
  answer gets `NotPausedError` and moves nothing.
- **Guarantee:** the pause's own contract ([Pauses](Pauses#concurrent-answers)); the charge that
  follows is P3.
- **Boundary:** two **different** pauses for one payment (two executions each asking) are two
  answers. The charge after them still needs a business key.
- **Proof:** the pause tests (`testWith(App, { instances: 2 })`). Full example: `ps11`.

### PS22. A retry with another card after a decline

The card is declined. The customer tries another card for the same order.

- **Wrong:** a new business key for every try: a try that timed out and was in fact charged is
  charged again by the next try.
- **AGBoss:** the same business key with another request is another fingerprint:
  `IdempotencyKeyConflictError`, refused, nothing sent.
- **Guarantee:** P2.
- **Boundary:** the application numbers payment attempts on its order row (`order:42:attempt:2`).
  It moves to the next attempt only once the previous one is **known** to be declined, never after
  an unknown outcome.
- **Proof:** the business-key conflict tests. Full example: `ps22`.

## The gateway's side

### PS15. A webhook delivered twice

Gateways deliver webhooks at least once, so the same event can arrive twice, or on two pods at
once.

- **Wrong:** every delivery is handled: an order marked paid twice, a fulfilment started twice.
- **AGBoss:**
  - The webhook starts an execution, and the step that applies it is a fenced effect under a
    business key made of the gateway's event id (`event:<gateway>:<eventId>`). The second delivery
    replays it.
  - A webhook that answers a pause (the payment's outcome) answers it once; the second gets
    `NotPausedError`.
- **Guarantee:** P2. Assumption: A9 (the write happens inside a step).
- **Boundary:** verifying the webhook's signature is the application's. A handler that writes
  outside an execution has no fence (A9).
- **Proof:** none in the core beyond the business key's own tests. Full example: `ps15`.

### PS16. Webhooks out of order

A refund event arrives before the payment's success event, or a failure of an old attempt after the
success of a new one.

- **Wrong:** each event's payload is applied as it comes: a refunded order ends "paid".
- **AGBoss:** nothing. AGBoss does not order another system's events.
- **Boundary:** the application. Treat the event as a hint: in the step, read the object's
  current status from the gateway (G6) and move the order's state only forward.
- **Proof:** none in the core. Full example: `ps16`.

### PS17. The idempotency key expires before a retry

The gateway keeps keys for a day (or three); the retry comes later. A pause answered after a
weekend, an operator's retry, a customer paying again the next day.

- **Wrong:** rely on the gateway's key alone: past its retention, a repeat is a new charge.
- **AGBoss:**
  - A `Completed` intent replays the stored receipt for `outboundCalls.retention` (default
    `hours(168)`), and nothing reaches the gateway.
  - A `Pending` intent is never removed, and is reconciled by lookup.
  - A `Failed` intent is sent again under the same key (see PS1).
- **Guarantee:** P3. Assumptions: A7 (G3) and A12 (retention).
- **Boundary:**
  - Past both the gateway's retention and AGBoss's, a repeat is a new charge, unless the
    application's order row refuses it: keep a unique "paid" record per order, written in the
    fenced effect's transaction.
  - Reconcile by the merchant reference, which does not expire, not only by the key.
  - A `Failed` intent of unknown outcome sent again past G3 is a second charge
    ([#657](https://github.com/agbossjs/agboss/issues/657)).
  - On a gateway whose only lookup is a replay of the key (Adyen; Stripe while its search lags),
    `reconcile` answers `notSent()` safely only inside the key's retention, and it is not told
    when the attempt was sent ([#658](https://github.com/agbossjs/agboss/issues/658)): record that
    time yourself until then, in a row of your own (a fenced effect's stored result is removed
    after `fencedEffects.retention`).
- **Proof:** none in the core for the gateway's retention; `outboundGatewayChecklist` probes G3.
  Full example: `ps17`.

### PS18. A partial capture

One authorization is captured in parts, for example one per shipment.

- **Wrong:** each capture keyed by its step: a second execution for the same shipment captures it
  again.
- **AGBoss:** a business key per capture, `capture:<authorization>:<n>`, with the amount in the
  request (so in the fingerprint). `n` comes from the application's ledger, in a fenced effect.
- **Guarantee:** P2, P3.
- **Boundary:** capturing more than was authorized is the gateway's check. The gateway must accept
  a key on the capture (G1 per operation).
- **Proof:** none in the core beyond the business key's own tests. Full example: `ps18`.

### PS19. A refund retried

The saga's undo, an operator and the customer's request may each refund the same payment.

- **Wrong:** a refund with no key, or with another key on each path: two refunds.
- **AGBoss:** every path refunds through an outbound call under one business key,
  `refund:<payment>:<n>`.
- **Guarantee:** P3. Assumption: A7.
- **Boundary:** two paths that build two keys make two refunds. One function should build the key,
  for every path.
- **Proof:** the outbound-call and business-key tests. Full example: `ps19`.

### PS20. A void and a capture race on one authorization

The customer cancels (void) while fulfilment captures the same authorization.

- **Wrong:** both act. The gateway refuses one, or a captured payment that the shop thinks it
  voided is never refunded.
- **AGBoss:** one business key for the authorization's outcome, `disposition:<authorization>`, with
  the action in the request. The second action is another fingerprint:
  `IdempotencyKeyConflictError`, and its execution takes the other route (a refund after a
  capture).
- **Guarantee:** P2, P3.
- **Boundary:** without such a key, the gateway's own state machine decides (a void after a capture
  fails), and the application must handle its error.
- **Proof:** the business-key conflict tests. Full example: `ps20`.

### PS21. A redirect or 3DS flow: the browser retries

The customer submits the payment form twice, loads the return page twice, or the redirect and the
webhook both report the outcome.

- **Wrong:** each request creates or confirms a payment.
- **AGBoss:**
  - Creating and confirming the payment are outbound calls under the order's business key.
  - The execution pauses for the outcome. The return page and the webhook both answer that one
    pause, and the second gets `NotPausedError`.
- **Guarantee:** P2, P3, and the pause's contract.
- **Boundary:** read the outcome from the gateway (G6) in the step, never from the redirect's query
  string.
- **Proof:** none in the core beyond the pause and business-key tests. Full example: `ps21`.

### PS23. Two requests under one key at once

The gateway receives a second request with the same key while the first is still being processed.

- **AGBoss:** sends one attempt per claim (a compare-and-set). Two requests under one key at once
  happen only in A6's window (a send hung past `attemptTimeout` plus the lease) or from another
  system.
- **Guarantee:** P3. Assumption: A6.
- **Boundary:** the gateway's own answer to a concurrent duplicate (some document a `409`, see
  [Payment gateways](Payment-gateways#the-ten-gateways)).
- **Proof:** the explorer and the fault suite stop such a send at its sender's fence on purpose.
  Full example: `ps23`.

## Found and fixed before 0.1.1

The 0.1.1 reviews found these races and fixed them before the release (#505, #508, #519). Each
keeps a regression test in the core.

| # | Race | Fixed by |
| --- | --- | --- |
| R15 | Two executions with one business key both read a `Failed` (or dead-lease `Pending`) intent and both send a new attempt | A compare-and-set on status, attempt and attempt owner, in one fenced transaction |
| R16 | A concurrent call with the same business key and another amount joins the one in flight and gets its receipt | Joining only on an equal fingerprint; otherwise `IdempotencyKeyConflictError` |
| R17 | Personal data and business keys in stored intents, results, failure texts and errors | Masking at write with the calling frame's policies (fails closed); business keys named by an HMAC handle |
| R18 | The lease released on a cancel while a step body that ignores its signal is still sending | A holder releases its lease only once the attempts under it settled |
| R19 | An expired lease renewed back to life after another pod acted on "expired" | Renewals check expiry; `leaseStateOf` closes an expired lease in the same atomic step |
| R20 | A lost completion (a superseded attempt) silently reported as sent | `OutboundCallOutcomeStatus.Superseded` and `outbound-call.superseded` on the log |
| R21 | A gateway key built from unescaped parts: two calls share one key | The tenant and business key URI-encoded in `call.idempotencyKey` |
| R22 | A send that never returns holds the lease and the shutdown forever | Bounded by `attemptTimeout` and the stop; then renewals stop and a takeover decides |
| R23 | A same-holder reclaim bumps the token, so an attempt still sending looks dead | A holder never yields its lease while an attempt under it sends (up to the `attemptTimeout` bound), so no reclaim moves the token under a live send |
| R24 | A replayed call whose result could not be stored returns a marker as the gateway's result | `OutboundCallResultNotStoredError`, nothing sent, the marker never returned |
