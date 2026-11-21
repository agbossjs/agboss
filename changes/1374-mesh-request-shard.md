---
section: Changed
issue: 1374
---

**The mesh request stores' once-only claim is a mutation shard at 100 %** (#1374) — `saveIfAbsent` of the in-memory and
the SQLite `MeshRequestRepository` is the whole guarantee behind a trusted MCP call that runs once, and no lease stands
behind it. Both files are now in the `once-mesh` shard, with their own tests (the claim by each part of the key, a repeat
refused with the first row kept, an answer and a delete for that key only, the sweep's cutoff, the copies the in-memory
store keeps). The reasons of `NON_SHARDED_SRC` for the execution tree's key store and the execution record store no longer
say "no spend, lease or cancel state": they name what each holds and where its fence is.
