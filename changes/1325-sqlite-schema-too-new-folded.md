---
section: Breaking
issue: 1325
---

**`SqliteSchemaTooNewError` is `StoreError.SchemaTooNew`** (#1325): opening a SQLite file stamped by a newer build fails with `StoreError.SchemaTooNew` (code `store.schema-too-new`, the stamp and the build's version as `details.applied` and `details.expected`); it was `SqliteSchemaTooNewError` (`sqlite.schema-too-new`). `SqliteSchemaTooNewError` and `SqliteSchemaTooNewErrorOptions` are removed from `@agboss/core`.
