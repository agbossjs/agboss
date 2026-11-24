---
section: Breaking
issue: 1288
---

**A polymorphic list also gives a typed slice per class** (#1288): a step that gives `listOf(ScoreDto, RejectedDto, FailedDto)` (an action, an agent) also gives `listOf(ScoreDto)`, `listOf(RejectedDto)` and `listOf(FailedDto)`, each the items of that class in their order and `[]` when there is none, so a node below reads `passed: listOf(ScoreDto)` without a type ladder. `[flow.unused-output]` checks each class: it is read through its slice or through the whole list. A list and its slices are twins: a newer value of one outdates the other at run time and in the analysis.
