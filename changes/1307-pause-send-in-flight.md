---
section: Fixed
issue: 1307
---

**A pause changed while its first send is in flight** (#1307, bug hunt 2026-11-25):
`app.reassignPause` of a pause whose channel is still being asked for the first time is refused
with `PauseError.UpdateContended` (retry is safe once the send returned) — before, a move during
the send made the asking step take its pause for withdrawn and fail the run, and an in-place change
never reached the channel. A channel that decides at once (`ChannelOutcome.decided`) while the
pause was answered, withdrawn or moved during `send` no longer acts on its own decision: the step
takes what the store recorded. A reassignment that sets a `timeout` counts against
`escalationLimits.maxExtensions` when it moves the pause to another target or channel too (a
`timeout-changed` entry in the replacement's chain of custody). Store follow-up: `PauseSeen.isSent`
is part of the reassignment's compare-and-set, and a replacement made with `countsAsExtension`
appends `timeout-changed` after `reassigned` and is refused at `maxExtensions` in the same write.
