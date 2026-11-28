---
section: Fixed
issue: 1356
---

**The A2A client, mesh-charge and once-mesh shards are mutation-tested to the bit** (#1356): exact tests for an MCP
call's id and ledger key, a remote run's reported tokens, the mesh request store's lease and fence, a trusted call's
lease renewal, the tenant and tokens an envelope carries, the MCP signed fetch's redirects and the A2A client's
bounds. Behaviour is unchanged; a few redundant conditions were removed so no equivalent mutants remain.

The `a2a-files`, `a2a-direct` and `ledger-a2a-client` shards get the same: exact tests for what a turn line keeps of a file, the file tier, the ttl of a saved file and the pool share of a read by url, a direct attempt's cancel, mask and tokens, the direct-message sweep, and the endpoint rules. A kept file's slots are numbered with a map, a download's bounds and the sweep's selection of completed messages are written so no equivalent mutant remains.
