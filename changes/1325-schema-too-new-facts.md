---
section: Changed
issue: 1325
---

**`StoreError.SchemaTooNew` carries `applied`, `expected` and `store`** (#1325b): the schema version the data is at, the newest this build knows and which store refused (`sqlite`, `postgres`, …), as typed optional facts — `error.applied` instead of a look into `details` (they are still there). `isStoreOutcomeUnknown(error)` and the `StoreOutcomeUnknown` type are exported by `@agboss/core/stores` as well as `@agboss/core`.
