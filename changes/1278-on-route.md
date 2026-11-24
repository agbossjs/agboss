---
section: Breaking
issue: 1278
---

**`.onRoute(subPath)` branches a router's choice** (#1278a). After `.toRouter(R)` (or `onRouter(R)`),
one `.onRoute(toAgent(A)…)` per route of `@Router({ routes })`: the starter (`toAgent`, `toAction`,
`toRouter`, `toWorkflow`, `toFinish`) names the target and its kind, the chain after it is what the
route continues with. The chain is a path only when every route is named, once (`RouterStep`,
`RouteStep`, `RouteCheck`, `StartOfPath`, `SideHead<TClaims, TStart>`); `[router.routes-mismatch]`
stays the assembly check. Consecutive `.onRoute(…)` calls are one `ChooseOneStep`. Not removed yet
(F1): `.chooseOne(…)` and `route(…)`.
