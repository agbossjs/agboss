# ADR-0027 — An intent before every outbound call; reconcile, never resend blindly

- **Status:** Accepted (#505)
- **Issue:** #505 (part of #479; business keys #508; PostgreSQL in #482)

## Context

The fenced effect (#500, [ADR-0026](ADR-0026-Fenced-effects-check-the-lease-in-the-same-transaction))
makes a write to the store's own database exactly-once. A call to another system — a payment API,
an e-mail, a webhook — cannot be in that transaction. A step that sent a charge and died before the
answer is run again by recovery, which sends again; nothing records what was sent, and a provider
without idempotency charges twice. A reviewer: "Reconciliation needs a record of every call that
left the system. I would store the request before sending it, not after."

## Decision

- **A core service over a repository contract:** `OutboundCalls.send(key, { target, operation,
  request, send, reconcile })` over `OutboundCallRepository`. The key is #500's
  (`fencedEffectKeyOf`), so a step run again finds its own intent; the call's idempotency key is the
  step's plus the name.
- **The intent is recorded before the call, in a fenced write** (the lease and the scope's mark, as
  #500) — a zombie can record nothing — and the lease is renewed (`fence.confirmNow()`) right before
  the network.
- **A pending intent is reconciled, never resent blindly:** the component's `reconcile` answers
  with a nominal verdict — `completed(result)`, `notSent()` (one more send, the same key) or
  `unknown({ reason })`. Unknown fails the step with `OutboundCallUnreconciledError` and keeps the
  intent pending: with someone's money, the framework never guesses.
- **Masked when written, by the calling frame's mask** (the application's and the workflow's PII
  policies): the request, the result and a failure's text. Every read surface — the operator's
  listing, a kept record, an export, the events — then shows what is stored, as it is, and none
  has to find the right policies again. The price: a replay returns the masked result, and
  `reconcile` gets the stored (masked) request — a call is looked up by its key, which is not
  personal data. No mask where policies exist fails closed (`OutboundCallUnmaskedError`).
- **Ended intents are kept a week, pending ones for ever:** reconciliation may come days later.
- **One sender per attempt (#505 PR 2):** every attempt has an owner — a random id minted by the
  caller that claims it — and a new attempt is a compare-and-set on status, attempt and owner in the
  fenced transaction: of two callers that read one intent, exactly one moves it and sends; the other
  sends nothing. A call this instance is making now is joined, never reconciled or resent. Rejected:
  a read-then-write move (two readers both resend) and an ownership test by lease alone (two calls of
  one execution share the lease).
- **One published contract suite** (`outboundCallContract`) for the in-memory, SQLite and
  PostgreSQL stores.

## Consequences

- An action that calls an external system has no intent table and no retry logic of its own — a
  `send` and a `reconcile`.
- Exactly-once still depends on the other system: idempotency keys and a lookup by key. Without a
  lookup an unknown outcome stays unknown and a person decides.
- A result should carry receipts and ids, not personal data, since a replay returns it masked.
