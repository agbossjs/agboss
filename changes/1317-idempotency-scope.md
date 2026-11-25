---
section: Breaking
issue: 1317
---

**What `runOnce` refuses inside its `execute`** (#1317, part c, the part that needs no store change) —
`IdempotencyError.NestedRunOnce` for a `runOnce` inside a `runOnce`, and
`IdempotencyError.ExternalCallInTransaction` for a `sendOnce` (so an `A2AClient` call) or a
`SpendRecorder.record` there: `execute` holds the store's transaction, and a store may run it again
(MongoDB retries a transient transaction error), repeating what it did. The scope lives in the async
context of `execute` and is closed when it ends, so a promise it left running is no longer inside it.
