---
section: Changed
issue: 1281
---

**A quorum join undoes the branches it went on without** (#1281b): an undoable `@Action` branch that
completed yet was not counted — an `@Arbiter` refused it, it belonged to a losing `.onGroup`, or it finished
after the quorum was decided — is undone at the join, once, by its compensation key, before the winning path
continues (`CompensationReason.QuorumExcluded`; `CompensationEntry.branchIndex` names the branch). A branch that
never completed has no entry, so nothing is undone for it; counted branches stay open until their committer or
a finish. A quorum that is not reached (`QuorumNotReachedError`) now undoes every completed undoable branch
like a failed join does (`JoinFailed`), notifies the branches' pauses, and starts `.onError` with the settled
answers as `optional(…)`.
