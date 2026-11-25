---
section: Breaking
issue: 1286
---

**`ChildPlacement.{CurrentProcess, AnyWorker, OtherWorker, IsolatedWorker}` on `@Workflow` and
`@Application`, not on the flow** (#1286a). Renamed: `ParentInstance` -> `CurrentProcess`,
`AnyInstance` -> `AnyWorker`; added `OtherWorker` (claimed only by a worker other than the launching
instance; with none, the parent's step fails with `StepError.ChildWorkerUnavailable` (`step.child-worker-unavailable`) after
`@Application({ executionLimits: { childClaimTimeout } })`, default one minute) and `IsolatedWorker` (a process of its
own, #1286b: `@Application({ isolatedWorker: { entry } })` names the module a forked process loads;
the instance forks one process per child, a worker with its own `instanceId` that claims that child
by its id; each fork holds one of the instance's step slots). The placement is the child's own
`@Workflow({ placement })`, else `@Application({ defaults: { workflows: { placement } } })`, else
`CurrentProcess`; a child never inherits its parent's. Removed: `{ placement }` on `.toWorkflow`,
`.toParallelWorkflows` and `route`, `ChildStepOptions`, `ToStep.placement`, `LaunchStep.placement`,
`ChooseOneRoute.placement`, `[flow.conflicting-placement]`. `QueuedChildExecution` gains `placement`
and `excludeInstanceId`; `claimFirstByStatusQueuedOrderByDepthDesc()` skips a row excluded for the
claiming instance and an `IsolatedWorker` row; `findQueuedIsolatedWorkerChildren(limit)` and
`claimIsolatedWorkerByTenantIdAndExecutionId(tenantId, executionId)` (the targeted claim) and
`withdrawByTenantIdAndExecutionIdIfQueued(tenantId, executionId)` (an `OtherWorker` child that timed
out is removed while it is still queued, so it never runs after its parent gave up; a claim that won
the race keeps the parent waiting) are new operations of the queue contract. The in-memory and SQLite queues do; the PostgreSQL,
MongoDB and Redis queues follow in the stores train.
