---
section: Fixed
issue: 1131
---

**A pause notice is never delivered twice at once, whatever the receiver's timeout** (#1131, #940):
the claim of a mailbox held 60 s and was not renewed, so a channel hook running under its tool's
`timeout` (minutes) or a chain of notices longer than a minute was called again by the next look —
on the same instance or another — beside the first call. The delivery now renews its claim while the
receiver runs (every 20 s, each renewal bounded to 5 s; a renewal never revives a lapsed or lost
claim). At least once stays the guarantee: a receiver that died is told again, under the same
`deliveryId`, once its claim lapsed. **Store authors:** `PausedExecutionRepository` gains
`renewNotice(claim, at, claimFor)`, checked by the contract case "renew extends the claim for its
token only" (the PostgreSQL, Redis and MongoDB stores get it with their re-pin, #1064).
