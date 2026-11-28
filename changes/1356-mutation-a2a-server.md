---
section: Changed
issue: 1356
---

**The `a2a-server` and `a2a-tasks` mutation shards are killed by real tests** (#1356): the A2A server, its MCP HTTP listener and the mesh's HTTP gate now catch their mutants with tests that assert exact HTTP statuses, codes and fixed texts, the owner a request acts as, the sessions' caps and their idle clock, the mesh's assembly rules (every number's edge, the replay window, the peers), what a signed request leaves in the replay store and until when, and where a task is from a record that says a stop or an answer with no result. Equivalent mutants were removed by rewrites that behave as before (an absent owner read through one helper, a recorded error's code read as it is because it already carries `internal`, the sessions' idle clock on `Clock.sleep` directly, a body's JSON read as `{ isJson, value }`, the MCP listener's failure answer in `mcp-http-failure.ts`, one unqualified predicate for the SQLite sweep's two deletes). No behaviour of the framework changes. No migration.
