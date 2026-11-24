---
section: Breaking
issue: 1281
---

**A join's failure handler is `.onError(E, …)`** (#1281, the rename part): `.onJoinError(E, …)` is
gone, `.onError(E, …)` stands right after `.join()`, `.joinQuorum(…)` or `.joinQuorumGroups(…)`,
before the join's `.returns(…)`. `.onError` is not offered between a launch and its `.join*()`. In
the AST `JoinStep.onJoinError` is `JoinStep.onError`; `agboss describe`, the rule messages and the
`join-error` handler table keep their meaning. The saga part of #1281 (undo of branches the quorum
left out, child undoables bubbling to the parent) is a separate change. In TypeScript the old name
is a compile error; rename each `.onJoinError(` to `.onError(`.
