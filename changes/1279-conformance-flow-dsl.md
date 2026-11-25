---
section: Breaking
issue: 1279
---

**Flow DSL conformance with the spec** (#1274, #1279, #1286, #1287). `Metadata` is an `abstract class`
with static methods (`MetadataFacade` is gone). `chooseMany` routers may return `[]`:
`RouterAnswers[R]` is `readonly Route<R>[]`. `@Router({ decidedBy: Code })` checks `route()` against
`RouterHandler<Self>` once the types are generated. `[router.no-model]` is removed: a model router
with no model anywhere fails with the cascade's `[model.missing-provider]`. `ChildWorkerUnavailableError`
is `StepError.ChildWorkerUnavailable` (`step.child-worker-unavailable`), caught by `.onError(StepError, …)`.
`childClaimTimeout` moved to `@Application({ executionLimits: { childClaimTimeout } })`. An application
with `ChildPlacement.IsolatedWorker` children and no `storage` (or `InMemoryDatabaseStorage`) gets a
temporary SQLite file shared with its forks. `FlowTypes.ClaimsOf` is renamed `SideClaimsOf` (the 0.1.0 helper of that name is gone).
