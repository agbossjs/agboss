---
section: Breaking
issue: 1325
---

**`ExecutionCancelFencedError` is `ExecutionError.CancelFenced`, a cancel and no hand-over** (#1325b, #909): a write refused after its tree's durable cancel is unwound as cancelled under the lease the instance still holds — it is no longer in the hand-over kinds, and no `.onError` takes it, as none takes a cancel. The class and its static `of(key)` are removed; a store builds the refusal with `cancelFencedOf(key)` from `@agboss/core/stores` (with `CancelFencedKey`). `ExecutionCancelledError` and its subclasses (`ExecutionStoppedError`, `ExecutionPausedError`, `ExecutionStopFencedError`, `ExecutionPauseFencedError`) are internal abort reasons now: gone from `@agboss/core`, in `@agboss/core/internal` with `isExecutionCancelled(error)`, the one test for a cancel, a stop or a fenced cancel. `isStoreOutcomeUnknown` and the `StoreOutcomeUnknown` type are also exported from `@agboss/core/stores`.
