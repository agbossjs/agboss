---
section: Added
issue: 945
---

**Expiry in quorums and plain joins: `BranchStatus.Expired`, settled answers, `joinFailed`** (#945,
#910): a branch whose pause expired ends `BranchStatus.Expired` — not `Cancelled`, not `Skipped` —
with its error `step.pause-expired` kept in `result.launches`. Under a quorum it did not vote, never
a failure of the launch whatever its `FailurePolicy`; `QuorumNotReachedError` gains `expired` (the
node ids of the branches that expired, also in `details` and the message). A pause asked in a quorum
branch is bound by the quorum's deadline (`PauseExpiryBound.Quorum`, kept in the contexts as
`quorumDeadlineAt`): at it the tree wakes by itself and the quorum decides. In a plain `.join()` an
expired branch follows its `FailurePolicy`: `Skip` drops it, `FailFast` fails the launch with the
branch's `PauseExpiredError` (`.onError`), withdrawing the branches still waiting. The side path of
`.onError(…)` reads the answers already settled: each branch output of the launch is an
`optional(…)` value of its first step's input (a per-item list stays a list), taken from the
checkpointed branch records. Each branch that had answered is told once that the launch failed:
`onPauseJoinFailed` on a channel (`ChannelPauseJoinFailedEvent`) and a `@PauseListener`
(`PauseListenerJoinFailedEvent`), at least once, written once per pause. A quorum whose pauses had no
deadline of their own now finds them `Expired` instead of `Withdrawn` when its deadline passes.
