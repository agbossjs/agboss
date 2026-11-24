---
section: Breaking
issue: 1324
---

**Paging and tenant-safety types** (#1324, part e-types, additive) — the foundation the listings and the tenant-safe `App` build on.

- **Added:** `PageQuery` (`{ cursor?, limit? }`) and `Page<TItem>` (`{ items, nextCursor? }`), from the root and `@agboss/core/stores`; `HasTenantContext<TApp>` (fail-safe: `true` unless the application is branded `false`), `TenantContextBranded`, `agbossTenantContext`, `TenantIdOption`, `TenantListScope`, `TenantPointArgs<TApp, TOptions>` and `TenantListArgs<TApp, TQuery>`.
- `ValidationError.TenantRequired` (`validation.tenant-required`) was already in the family; nothing changes there.
- **Still there until their owners:** `ExecutionHistoryPage`, `PausesPage`, `OutboundCallPage`, `A2ATaskPage` (the consumers migrate to `Page`).
