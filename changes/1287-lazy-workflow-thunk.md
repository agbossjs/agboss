---
section: Breaking
issue: 1287
---

**A workflow launches itself with a thunk of its own class; `ThisWorkflow` is removed** (#1287).
`.toWorkflow(…)`, `toWorkflow(…)` of a side path, `onWorkflow(…)`, `route(…)` and
`.toParallelWorkflows(…, { maxItems })` take `Class | (() => Class)`: write
`.toWorkflow(() => TopicResearchWorkflow)` inside `@Workflow({ flow })` of that very class. The thunk
is read when the flow is analysed, after every module has run, so the temporal dead zone is no
issue; it carries the real `typeof TopicResearchWorkflow`, so Go to Definition and Rename Symbol
work. `@Workflow` returns nothing, so a class's type does not depend on its own decorator (no
TS2506 / TS7022); the brand comes from `.agboss/types.d.ts` only. A recursion is a node named by the
workflow itself (it was `this-workflow`), in `agboss describe`, Studio and the worst case.

`AGBossTypes.Inputs[workflow]` is the union of the workflow's starts' inputs (the problems of the
paths into it still win), for every workflow.

Removed: `ThisWorkflow`, `ThisWorkflowOutputs` (the generated table and its type), `ThisWorkflowCheck`,
`ThisWorkflowClaim`, `ThisWorkflowStep`, `ThisWorkflowJoined`, `ThisWorkflowLaunched`,
`ThisWorkflowSwitching`, `ThisWorkflowName`, `WithClaims`, `ClaimsCheck`, `EntryOf`,
`ChildLaunched`, the `claims` parameter of `SourceHead`, `RouteHead`, `CaseHead`, `SideHead` and
`GroupHead`, and the recursion's `describe` wording `ThisWorkflow, recursive` (now `recursive,
maxDepth N`). A flow that names its own class is no longer `[graph.mutual-recursion]`: that is the
recursion. Added: `ClassOf` (a `FlowTypes` helper).
