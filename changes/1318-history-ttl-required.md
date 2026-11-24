---
section: Breaking
issue: 1318
---

**`@Workflow({ historyTtl })` is required** (#1318, flip F2). A workflow says how long the history of its finished executions is kept: a duration (`days(90)`), `Ttl.Forever` (never swept) or `Ttl.None` (no history is kept). A workflow that leaves it out is `[limits.history-ttl-required]` at assembly, and `WorkflowOptions["historyTtl"]` is no longer optional in the type. Every in-repo `@Workflow` (tests, examples, docs, skills, CLI templates) names it.
