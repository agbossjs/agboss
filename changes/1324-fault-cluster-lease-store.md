---
section: Fixed
issue: 1324
---

**A fault suite with `FaultStorage.cluster` starts its pods** (#1324b): the pod's `@DatabaseStorage` driver now names the set's durable lease store (`leaseStore`: the set's own `ExecutionLeaseRepository` class on the database's backend, such as `SqliteExecutionLeaseRepository`) when the set gives a `cluster`; before, every pod of such a suite ended with `[storage.cluster-needs-durable-lease-store]`. A set without a `cluster` is built as before.
