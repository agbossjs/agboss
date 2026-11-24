---
section: Breaking
issue: 1303
---

**A `@Workflow` without `memory` is stateless** (#1303, D8): its agents and routers read no earlier turn of a thread (before, they read the last 5). Reuse of a thread that already has turns by such a workflow logs the warning `memory.thread-reuse-without-memory` (once per execution, the framework's log, no thread id or text in it) — set `memory` on the workflow, or on the agent or router that should remember. Pruning the stateless workflow's finished thread rows and the `ttl` sweep come with the stores' migration (#1303c).
