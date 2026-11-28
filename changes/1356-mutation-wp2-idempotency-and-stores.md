---
section: Changed
issue: 1356
---

**The idempotency, lease and store mutation shards kill their mutants** (#1356): the nightly mutation run
went red on `keys-and-calls`, `fencing-effects`, `fenced-reach`, `fencing`, `cancel-stores`, `cancel-x-runs`,
`fence-checkpoint`, `fence-config`, `fence-workers` and `once-child` after the 0.1.1 rework added `Idempotency`, the
pause and stop marks and the SQLite connection's async lock wait without tests that assert their exact errors,
messages and branches. The new tests assert them (every option `Idempotency.runOnce` and `sendOnce` refuse with its
text, the bound of an attempt and what a timed-out one leaves behind, a rotation of the idempotency secret over the
in-memory stores, the SQLite connection's transactions and priority statements, the in-memory stop and pause
fences, the effect reach of an A2A skill). Dead code that left equivalent mutants is removed with no change of
behaviour: a call in `sendOnce` that could not throw, details an error repeated from its facts, guards that only
narrowed a type. No migration.
