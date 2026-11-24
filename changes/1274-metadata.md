---
section: Breaking
issue: 1274
---

**`Metadata` tells where a value of a flow path came from** (#1274a, next to `Produced`, which #1274b removes). `Metadata.of(value)`, `.has(value)`, `.createdBy(value)`, `.ancestors(value)` and `.with(value, options)` read and state a value's `ValueMetadata` (`valueId`, `slot`, `createdBy` — the creator's class, a child workflow's class across its boundary —, `visitNumber`, `itemIndex`, `parents`). The facts live in a module-private `WeakMap` keyed by the value, never as a property of it, so `structuredClone`, `Reflect.ownKeys` and JSON see plain data; `Metadata.with` copies and keeps the prototype. The runtime records every value a node reads (a field, a list item, a `historyOf` version); a value two slots share is copied, never given two sets of facts. Added types: `Tracked<T, TComponent>` (a phantom `[valueMetadata]` brand, never set), `Untracked<T>`, `ValueMetadata`, `MetadataOptions`, `MetadataFacade`.
