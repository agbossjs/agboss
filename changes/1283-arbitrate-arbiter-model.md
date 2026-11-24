---
section: Breaking
issue: 1283
---

**`@Arbitrate(…targets)`, the injectable `ArbiterModel`, `@Arbiter` without `decidedBy`** (#1283a).
`@OnAnswer(Agent)` is `@Arbitrate(A, B, …)`: one method judges the answers of one or more targets (the
parameter is the union of their outputs, `Tracked` as that target gave it, so
`Metadata.createdBy(answer)` tells them apart); the method name is yours (`[arbiter.method-name]` is
gone), and `[arbiter.answer-method-on-model]` with it. `@Arbiter` takes no `decidedBy`: `criteria` makes
a model arbiter (`ArbiterCriterion.agent` is `target`), `@Arbitrate` methods a code arbiter, `@Arbiter()`
alone is allowed. A code arbiter that lists `deps: [ArbiterModel]` (and an optional `model` /
`modelProvider`, resolved by the #1313 cascade; without `ArbiterModel` they do not compile) decides at
`$0` where it can and calls `arbiterModel.decide(…)` / `.invoke(…)` where it must: each call is checked
against the execution's budgets first, charged under `arbiter:<name>`, and a failed call's partial
spend is kept in the `ArbiterError` (a limit or a cancel passes through, its spend handed to the branch).
`testUnit(HybridArbiter, { model })` scripts it. Rules renamed `[arbiter.unhandled-target]`,
`[arbiter.unknown-target]`, `[arbiter.duplicate-target]`; new `[arbiter.branch-has-no-output]`. New:
`Arbitrate`, `ArbiterModel`, `ArbitrateDecorator`, `ArbitratedAnswerOf`, `TrackedAnswerOf`,
`HybridArbiterModelOptions`; removed: `OnAnswer`, `OnAnswerDecorator`, `ModelArbiterOptions.decidedBy`,
`CodeArbiterOptions.decidedBy`, `ArbiterCriterion.agent`. `agboss generate arbiter` writes one
`@Arbitrate(A, B)` method. Non-agent targets (`@ExternalTask`, `@Action`, `@Workflow`) are accepted by
the decorator and the rules; their generated answer types and a text agent's `WorkflowFinishTextDto`
answer come with #1283b.
