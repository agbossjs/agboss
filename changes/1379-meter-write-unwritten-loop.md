---
section: Fixed
issue: 1379
---

**A budget meter's write of unwritten spend can no longer call itself for ever** (#1379): `BudgetMeter`'s read of the counters first wrote the spend whose write had failed, and that write read the counters after it, which wrote the unwritten spend first, and so on. Only one line (`if (records.length === 0) return;`) ended the chain, and a change that lost it made a loop of microtasks that no timer, test timeout or heap limit ended in time: the process grew to its 4 GB heap before it died. That is why two mutants of the line were a Timeout of 180 s in every full run of the `money` mutation shard and Killed in 4 s when run alone (which tests ran first decided whether anything still ran a timer). The write of the unwritten spend now reads the counters without writing it again (it has just taken it out of the unwritten), so the chain has no cycle; behaviour is the same. The mutants are Killed in a cold run, and their two entries are out of `scripts/stryker-proven-hangs.json`. No migration.
