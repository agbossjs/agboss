---
section: Changed
issue: 1366
---

**The fence, lease and cancel rules acceptance of #1356 listed are mutated** (#1366, #1065, #1165): six new Stryker shards at 100 % — `fence-checkpoint` (a checkpoint is written only after the lease was renewed, the thread's latest checkpoint after a step back of the clock, a leg is announced only while its lease is held), `fence-tree` (the end of a tree whose instance died, the pause deadline's move and drain, a child's failure announced by the pass that holds the tree), `fence-workers` (the queued children's workers under a lease each, the lease and the slots a step runs under), `fence-config` (the pairing of a fencing store with the lease store at assembly, the retentions above the lease), `cancel-x-runs` (the runs a cancel aborts by thread and by tree, a branch's cancelled end, the remote task cancelled at its deadline) and `cancel-x-pauses` (a tree's end that closes its pauses, the expiry a cancel beats, the pauses a launch withdraws, the pause step's answer). The sixteen files leave `NON_SHARDED_SRC`.
