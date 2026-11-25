---
section: Breaking
issue: 1313
---

**`DecisionModel`: the injectable decisions service; `ROUTER_FACTORY`, `RouterEngine` and `RouteRequest` leave the public API** (#1313):
a `@Tool` or an `@Action` takes `deps: [DecisionModel]` and calls `decide({ state, questions }, { model?, modelProvider? })`
for typed answers to closed questions (`Decision.boolean` / `choice` / `score`). The model is the call's own, else the
`modelProvider` cascade of its workflow and application. The call is stopped by an exhausted budget before any request,
its cost (and the cost of a billed answer that could not be used) is the tool call's spend: the execution's cost report,
its budgets and the ledger. `ROUTER_FACTORY`, `RouterEngine`, `RouteRequest`, `RouteOutcome`, `RouteOption` and
`RouterDecision` moved to `@agboss/core/internal`. Migration: replace `routers("name").route(...)` by `decisions.decide(...)`.
