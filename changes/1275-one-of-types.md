---
section: Breaking
issue: 1275
---

**`.toOneOf([…])` and `.onFinish(…)` are exhaustive at compile time** (#1275c). A side path now
carries in its type the DTOs its entry consumer reads (`SideHead<TClaims>`, `ClaimsOf`,
`ClaimedDtosOf`; leading steps that read nothing are skipped). `.toOneOf([…])` does not compile when
a branch reads several variants, two branches read one, a variant has no branch, or more than one
branch reads none (`OneOfCheck`). A child's `.onFinish(ChildFinish, …)` chain is a path only when
every finish is named once (`WorkflowFinishStep`); a missing finish is a compile error at the
`@Workflow({ flow })` entry, a repeated one at the call.
