---
section: Fixed
issue: 1341
---

**`app.unpause` after a park that followed an answered pause** (#1341, bug hunt 2026-11-25): a
tree resumed from a business pause and then parked by `app.pause` is read as parked from its open
pauses, never from the stale paused run of its earlier rest — `app.unpause` continues it from its
checkpoint (`running/unpause`, `ResumeReason.Unpaused`) instead of returning a `paused` state with
nothing pending, and a second `app.pause` of it is `externally-paused`. The operator's `reason` of
`app.cancel`, `app.stop`, `app.pause` and `app.unpause` is kept through the workflow's PII policy
(status history, lease row, request key), as a reassignment's reason is.
