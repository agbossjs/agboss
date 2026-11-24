---
section: Breaking
issue: 1282
---

**`.arbitratedBy(ArbiterClass)` replaces `.acceptedBy(…)` and `anyOf(…)`** (#1282). One `@Arbiter` class
decides which answers of a launch count — once per launch; there is no `anyOf`, no AND of several
`.acceptedBy(…)` and no and / or predicate tree: how a rule escalates from `$0` code to a model lives
in the class (`ArbiterModel`, #1283), the flow only names which rule applies. It stands right after
`.inParallel([…])`, `.forEachItem(…)` or `.toParallelAgents(…)` and is followed by a quorum join, never
`.join()`. This also lifts the refusal of #1279 / #1280: `.joinQuorum({ min, max, deadline })` and
`.joinQuorumGroups(…)` now follow `.inParallel([…])` (branches of any kind), and `.joinQuorum(…)` follows
`.forEachItem(…)` — with `{ maxItems }` the join still needs its `.onError(LimitError.Items, …)`; groups
are refused after `.forEachItem(…)`, every item runs one target. New: `.arbitratedBy(A)` on
`FixedArbitratedQuorums` (after `.inParallel`), `PerItemArbitratedQuorums<THead, TNeedsItemsError>` (after
`.forEachItem`), `PerItemLaunched`, `TakeFirstLaunched`, `NeedsItemsQuorumHandler`,
`LaunchStep` / `InParallelStep` / `ForEachItemStep` `.arbitratedBy`, `FlowLaunch.arbitratedBy`,
`LaunchSnapshot.arbitratedBy` (`agboss describe`). Removed: `.acceptedBy(…)`, `anyOf`, `AnyOfArbiters`,
`ArbiterChoice`, `AcceptedBy`, `LaunchStep.acceptedBy`, `FlowLaunch.acceptedBy`,
`LaunchSnapshot.acceptedBy`. A void `@Action` branch of an arbitrated launch is
`[arbiter.branch-has-no-output]`. `agboss generate arbiter` finds the agents of an `.inParallel([…])` /
`.forEachItem(…)` launch too. The calendar rule of a `WorkingDuration` deadline stays with #1306.
