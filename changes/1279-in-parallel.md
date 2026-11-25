---
section: Breaking
issue: 1279
---

**`.inParallel([…branches], { maxConcurrency })` and `.onError(E, skip())`** (#1279a). Branches of any
kind in one array — `toAgent(A)`, `toAction(X)`, `toExternalTask(Q)`, `toWorkflow(W)` (a class or a
thunk) — each with an optional `.onError(E, skip())`: a failure of that class (a `StepFailedError`
under it, or one caused by it) drops the branch out of the join, its value is `optional(…)`, the
launch goes on; a limit or a cancel is never skipped. `FailurePolicy.Skip` of a router route is the
same rule now (`BranchTicket.skip`, error codes). New: `skip()`, `inParallel([…])` (a starter for
side paths), `ParallelBranchStep`, `InParallelStep`, `ParallelTargetKind`, `StepKind.InParallel`,
`FlowLaunch.call`, `LaunchBranch.kind` / `skip`, `[launch.skip-differs]`. A quorum after
`.inParallel` comes with `.arbitratedBy` (#1282). Not removed yet (F1): `.toParallel…(…)`.

**`toRouter(R).chooseMany([…])` and flat code-router routes** (#1279b). Inside `.inParallel([…])` a
router branch lists the branches it picks among: the router is entered first, then it launches its
choice next to the unconditional siblings (`ToStep.chooses`, `ParallelBranchStep.chooses`,
`FlowLaunch.chooser`); a code router's `route()` returns the chosen classes, a model router decides
each route with one yes/no; an empty choice is an answer. `[router.routes-mismatch]` compares the
branches with `@Router({ routes })`. A code router's `routes` may be a flat list of classes
(`routes: [A, () => B]`). `spawn` / `failure` of a route stay until F1.
