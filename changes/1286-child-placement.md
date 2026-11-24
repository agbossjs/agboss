---
section: Breaking
issue: 1286
---

**`ChildPlacement.{CurrentProcess, AnyWorker, OtherWorker, IsolatedWorker}` on `@Workflow` and
`@Application`, not on the flow** (#1286a). Renamed: `ParentInstance` -> `CurrentProcess`,
`AnyInstance` -> `AnyWorker`; added `OtherWorker` (claimed only by a worker other than the launching
instance; with none, the parent's step fails with `ChildWorkerUnavailableError` after
`@Application({ childClaimTimeout })`, default one minute) and `IsolatedWorker` (declared; running it
is #1286b, until then `[workflow.isolated-worker-unavailable]`). The placement is the child's own
`@Workflow({ placement })`, else `@Application({ defaults: { workflows: { placement } } })`, else
`CurrentProcess`; a child never inherits its parent's. Removed: `{ placement }` on `.toWorkflow`,
`.toParallelWorkflows` and `route`, `ChildStepOptions`, `ToStep.placement`, `LaunchStep.placement`,
`ChooseOneRoute.placement`, `[flow.conflicting-placement]`. `QueuedChildExecution` gains `placement`
and `excludeInstanceId`; `claimFirstByStatusQueuedOrderByDepthDesc()` skips a row excluded for the
claiming instance and an `IsolatedWorker` row. The in-memory and SQLite queues do; the PostgreSQL,
MongoDB and Redis queues follow in the stores train.
