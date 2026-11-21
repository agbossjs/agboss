---
section: Changed
issue: 1366
---

**What is counted once in a child's execution is mutated** (#1366): the channels of an execution's and of an agent loop's state, where the spend is appended and the counters added (`once-state`); a child's step in its parent, a child on any instance and the wait of its parent, the queued child's pass and the end its worker announces (`once-child`); an outbound call's envelope and a trusted MCP call that runs once (`once-mesh`) are three new Stryker shards at 100 %. A queued child's pass is tested for which spend its budget starts from and which it takes as in the ledger already — fresh, recovered and resumed with a reply. `src/mcp/**` is listed file by file in `tests/docs/non-sharded-src.ts`.
