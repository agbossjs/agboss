---
section: Breaking
issue: 1275
---

**`.toOneOf([…branches])` branches a `oneOf(…)` output without naming a DTO in the flow** (#1275a).
Each branch is a side path (`toAction(…)`, `toAgent(…)`, `toRouter(…)`, `toExternalTask(…)`,
`toWorkflow(…)`, `toFinish(…)`) and takes the variant its entry consumer reads: the `input` of its
first agent, action, router or `@ExternalTask`, the `output` of a `toFinish`, the start input of a
child workflow, past leading actions that read nothing. When `N − 1` branches read `N − 1` variants,
the one branch that reads none takes the variant left. The branches are an array of two or more
side paths. Added: `.toOneOf([…])`, `StepKind.OneOf`, `OneOfStep`, and the rule codes
`[flow.one-of-not-exhaustive]` (a variant no branch reads, or a transition right after a `oneOf(…)`
output without `.toOneOf([…])`) and `[flow.one-of-ambiguous]` (a branch that reads several variants,
a variant read by several branches, a branch that reads none with no variant left, or
`.toOneOf([…])` after a step without a `oneOf(…)` output). `.switch(caseOf(…)…)` stays until the
flow flip (F1); a transition right after a `oneOf(…)` output is now `[flow.one-of-not-exhaustive]`
instead of `[flow.switch-not-exhaustive]`.
