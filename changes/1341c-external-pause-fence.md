---
section: Breaking
issue: 1341
---

**The external pause and its fence** (#1341, part c, store layer and guards): the lease row of a tree carries
an external pause — `ExecutionLeaseRepository.requestPause(tree, { mode, reason? }, transition?)`,
`unpause(tree, transition?)`, `pauseOf(tree)` (and `markedOf`, which now also answers `pause` and
`fencedThroughToken`: `TreeMarks`, `PauseMarks`, `PauseRequest`) — and `fencedThroughToken`, **monotonic
(`GREATEST`) and never cleared on the same token**: an `Immediate` pause fences the row's current token, a
write of the root lease at that token or below is refused with `ExecutionFencedError` (a cancel marked
after it, an undo's key too — the stale step stays fenced), a lease taken again at `token + 1` (an unpause, a
cancel's unwind) is not; `unpause` clears the pause and its reason and never lowers the fence. The mark and
the status-history row are one transaction.

`dual_paused` guards (a tree paused from outside while a business pause is open): `app.resume` of an answer
is refused in stage 1, before it is recorded, with `ExecutionError.ExternallyPaused` — the pause stays open
and the same answer works after the unpause; an expiry look and the sweep's wake of an answered pause skip
the tree (a timer or an answer never undoes the operator's freeze).

Not in this part (open in #1341): `app.pause` / `app.unpause` themselves — parking a running execution at its
next checkpoint, `PausedExecutionOutput.isExternallyPaused`, `ResumeReason.Unpaused`, `PauseRequestState`,
the `Pausing`/`DualPaused` history rows written by the commands, the cancel that takes `token + 1` while the
holder still runs, propagating the fence to child leases, the orphan look of a crashed pause, `InterruptReason.Paused`.

Store follow-up (train T3): on the lease row `is_externally_paused`, `external_pause_reason`,
`fenced_through_token` (written by `requestPause` / `unpause` with the history row in one transaction; the
fence is `GREATEST` — `MAX(COALESCE(old, 0), lease_epoch)` — and survives every release, retire, take and
unpause); the fenced-effect and outbound-call checks refuse a write of the root lease with
`token <= fenced_through_token` with `ExecutionFencedError` (observedToken = the fence); `markedOf` answers
all three marks in one read; Redis keeps the fence in its lease hash too and re-pushes `requestPause` /
`unpause` on every call, the database row the authority (D6). New contract cases:
`execution-lease-pause.cases.ts`, `fenced-effect-pause.cases.ts`.
