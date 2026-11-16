---
section: Changed
issue: 1198
---

**`ExecutionIdStore` (the type of `EXECUTION_ID_STORE`) now includes `requestCancel` and
`isCancelRequested` beside `claimExecutionId`** (#1198). A coordination lease store
(`RedisExecutionLeaseRepository`) hands the tree's cancel mark to the durable store under that token
(#1117), and a store without those methods now fails at compile time instead of at construction. Every
durable lease store already has them: the change is additive for `PostgresExecutionLeaseRepository`,
`MongoExecutionLeaseRepository` and `SqliteExecutionLeaseRepository`.
