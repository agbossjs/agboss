---
section: Changed
issue: 1366
---

**The functions that refuse a step, a call or a reply for a budget are mutated at 100 %** (#1366): three new Stryker shards, `budget-loop` (an agent's loop: the check before each model call and after the one that asks for tools, the model-call and tool-call limits, the exhausted signal on a call in flight, the spend of a tool, of the input's guardrails and files and of the judges counted at once, the check before a question is asked, the mesh budget a tool call hands on), `budget-flow` (the flow's visits and launches: the limits a visit checks and the spend a visit and its owed undo carry, the exhausted signal a branch watches, the check before an arbiter's model call, a guardrail's check of an answer's files) and `budget-reply` (the reading of a free-text reply against the tree's budgets). A file mutated only in its budget functions is named in `PARTLY_SHARDED_SRC` of `tests/docs/non-sharded-src.ts` with the reason the rest is not.
