# ADR-0033: A pause has a deadline decided in the store

Status: accepted (#910, #941)

## Context

A pause nobody answers waited forever. A deadline needs three things at once: a clock every instance
agrees on, an answer and an expiry that cannot both win, and a channel that may decide for the absent
person without being asked twice.

## Decision

- The absolute deadline (`expiresAt`) is fixed when the pause is made: the smaller of `askedAt + expiresIn`
  (step or tool over role) and the run's deadline; a tie goes to the run. A deploy never moves an open pause.
- The deadline is hard and decided **in the store's compare-and-set**: an answer needs `expires_at > at`, an
  expiry closes the pause once (`expireByTenantIdAndPauseId`); the loser gets `PauseClosedError`. Interpreters
  and instance clocks decide nothing.
- Expiry is done by an expiry look in every instance's pause timers, under the tree's lease: it asks the
  channel (`onPauseExpired`, once per expiry, read-only by contract) and closes the pause in the CAS. The tree's
  root is made `running` **before** the close, so a crash leaves recovery work, never a `paused` root beside a
  closed pause.
- A cancel always beats an expiry: the look checks the tree's cancel request at the take and before the
  decision and the CAS.
- `fail()` (default) fails the step with `PauseExpiredError`; `decide(answer)` continues as answered by the
  channel (`DecidedOnExpiry`). A run's deadline bounds every pause and fails the run.

## Consequences

Fault scenarios 24–24e and the invariants `one-expiry-decision`, `no-paused-root-with-closed-pause`,
`no-answer-after-deadline` are the contract of every store set; sabotages (an expiry outside the CAS, a
forgotten root mark, a cancel mark that never lands) stay as permanent negative tests. PostgreSQL, Redis
and MongoDB re-pin them in follow-ups.
