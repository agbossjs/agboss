---
section: Changed
issue: 1366
---

**The functions that write money to the ledger are mutated at 100 %** (#1366): five new Stryker shards, `ledger-run` (the spend a run records as it is made, a turn's cost, what a recovered or a resumed pass starts from and does not record again, the spend a failure's record carries), `ledger-memory` (the strategies' update after a turn, the compactions before an execution: every model call recorded once, the cost a summary is stored with, the budget left for the next), `ledger-branch` (the spend of one branch of a launch: its node, its arbiters' decisions, its services, a failed or a cancelled branch's), `ledger-a2a-client` (the price an A2A call charges at the accept and settles after the wait, a refused call charged for neither) and `ledger-retention` (what the sweep removes once its retention is over, the ledger's entries among it, and a knowledge base's search spend). A file mutated only in its money functions is named in `PARTLY_SHARDED_SRC` of `tests/docs/non-sharded-src.ts` with the reason the rest is not.
