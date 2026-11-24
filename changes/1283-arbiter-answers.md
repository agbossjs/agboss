---
section: Changed
issue: 1283
---

**Arbiter answers of every target kind, and a rule for `model` without `ArbiterModel`** (#1283b). A text
`@Agent` (no `output`) gives `@Arbitrate(…)` its reply as a `WorkflowFinishTextDto`: `answer instanceof
WorkflowFinishTextDto` and `Metadata.createdBy(answer)` hold at run time and in `testUnit`, and
`ArbiterAnswerOf<TextAgent>` is `WorkflowFinishTextDto` rather than a refused `NoAnswerToJudge`. An
`@ExternalTask` target answers its output DTO and a `@Workflow` target its finishes' output, both typed.
New assembly rule `[arbiter.model-without-arbiter-model]`: a code `@Arbiter` that names `model` or
`modelProvider` without `ArbiterModel` in `deps` (past the types, from plain JS or parsed options).
