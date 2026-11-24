---
section: Breaking
issue: 1279
---

**F1 flip, flow forms** (#1275, #1278, #1279, #1280). The old flow forms are removed, with no aliases:
`.switch(caseOf(Dto)…)` and `caseOf` (use `.toOneOf([…])` or `.onFinish(F, …)`); `.chooseOne(route(X)…)`
and `route` (use one `.onRoute(toAgent(X)…)` per route); `.toParallelAgents(…)`, `.toParallelActions(…)`
and `.toParallelWorkflows(…)` (use `.inParallel([toAgent(A), …])`; per item, `.forEachItem(toAgent(A), { takeFirst })`,
a rewritten `maxItems` becomes `takeFirst`); `SpawnPolicy`, `FailurePolicy` and the `spawn` / `failure` of a route
(a router in a launch is `toRouter(R).chooseMany([…])`, a failed branch is dropped by `.onError(E, skip())`);
`CodeRouterRoute`, `AlwaysRouterRoute`, `RouterRoute`; `StepKind.Launch`, `StepKind.Switch`, `LaunchStep`,
`SwitchStep`. A model router's route is `{ target, prompt }`, a code router's route is its class. Rule codes
`flow.switch-not-exhaustive`, `flow.switch-unknown-case`, `router.spawn-required`, `router.prompt-on-always`,
`router.all-routes-always`, `router.policy-with-choose-one`, `launch.max-items-required` and
`launch.max-items-without-list` are gone; `[router.no-prompt]` stays for a model router's route without a
prompt. An empty answer of a `chooseMany` router is valid. `agboss generate agent` and the workflow
template write and wire `.onRoute(toAgent(X)…)`.
