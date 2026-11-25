---
section: Breaking
issue: 1275
---

**`.onFinish(ChildFinish, subPath)` branches a child workflow by the finish it ended at** (#1275b).
After `.toWorkflow(W)` a child with two or more finishes is continued with one
`.onFinish(KycFraudFinish, toAction(…)…)` per finish, named by the `@WorkflowFinish` class, never by
a DTO: two finishes may give one DTO, which `.toOneOf([…])` cannot tell apart. Every finish of the
child is named once. Added: `.onFinish(…)`, `StepKind.OnFinish`, `OnFinishStep`,
`ChildWorkflow.finishes`, `FlowEdge.caseKey` (what a branch is picked by: the DTO class name of a
`.switch` / `.toOneOf` branch, the finish's component name of an `.onFinish` branch), the generated
table `AGBossTypes.WorkflowFinishes` (each child workflow's finishes as classes) and
`readonly finishes` on every `AGBossTypes.WorkflowStarts` entry (the finishes the start reaches).
A finish that is not the child's, one named twice, one left out, or `.onFinish` next to a transition
after the same child are `[flow.one-of-ambiguous]` / `[flow.one-of-not-exhaustive]`.
