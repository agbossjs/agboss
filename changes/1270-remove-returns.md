---
section: Breaking
issue: 1270
---

**`.returns(…)` is removed from flow paths; what a step gives is derived from its declaration**
(#1270). A start gives its `input` (one value per field of a map), an agent, action, question role
or child workflow its `output`, a text agent its reply as `WorkflowFinishTextDto`, a join the values
of its branches (`listOf(XDto)` for copies and per-item runs, `optional(XDto)` for an `OnDemand` /
`Skip` route or a quorum that may leave an answer out), and `group(…)` of `.joinQuorumGroups(…)` its
agents' values. A step with a `oneOf(…)` output is continued with `.switch(caseOf(…)…)`; one with a
list output followed by a single launch target runs once per item.

Removed: `.returns(…)` (and `ThisWorkflowReturning`, `Returning`, `JoinValues`, `StepValues`,
`ValuesLeft` and the other `returns-types` helpers), `StepKind.Returns`, `ReturnsStep`,
`ReturnedValue`, `JoinStep.returns`, `QuorumGroup.returns`, `LaunchStep.perItem`, the `JoinOutputs`
table of `.agboss/types.d.ts` (and `JoinOutputOf`, `LaunchKey`, `TargetNames`, `GroupValues`), the
`join` member of `ThisWorkflowOutputs[name]`, and the rules `[flow.returns-mismatch]` and
`[flow.quorum-return-not-optional]` (a quorum's optional answers are enforced where they are read,
`[input.missing-on-path]`). Added: `[launch.unjoinable-output]` (a branch's output no join value can
carry); a transition right after a `oneOf(…)` output is `[flow.switch-not-exhaustive]`. In
TypeScript every `.returns(…)` is a compile error: delete the call.
