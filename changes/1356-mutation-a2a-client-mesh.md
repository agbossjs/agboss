---
section: Fixed
issue: 1356
---

**The A2A client, mesh-charge and once-mesh shards are mutation-tested to the bit** (#1356): exact tests for an MCP
call's id and ledger key, a remote run's reported tokens, the mesh request store's lease and fence, a trusted call's
lease renewal, the tenant and tokens an envelope carries, the MCP signed fetch's redirects and the A2A client's
bounds. Behaviour is unchanged; a few redundant conditions were removed so no equivalent mutants remain.
