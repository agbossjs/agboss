---
section: Fixed
issue: 1281
---

**A launch's failure leaves nothing done for good** (#1281): a quorum branch whose undoable action,
or child workflow, had succeeded lost its undo when its arbiter threw (`ArbiterError`) or its
arbiter's model call met a spent budget — the entry was opened only after the arbiters ran, so the
reservation was never released. The branch now opens its entries as its node answers and fails with
them; its join undoes them (`CompensationReason.JoinFailed`) and counts the node's spend. And a join
that fails into its `.onError` — a failed branch, a quorum not reached, a list past `maxItems`, a
quorum deadline's calendar — now undoes what the execution's finished children left open before the
side path (`CompensationReason.StepFailed`), as a plain step's failure does; before, the side path's
finish committed it. Durable once across a takeover. An undo visit held back by a limit (#675) no
longer takes a child's moved entry for its own. No migration.
