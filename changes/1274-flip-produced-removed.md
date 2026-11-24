---
section: Breaking
issue: 1274
---

**An input field is the DTO itself; `Produced` and `.value` are gone** (#1274b, flip F1). `InputOf<Self>` gives `Tracked<XDto, typeof Producer>` per field (`readonly Tracked<…>[]` for a list, `HistoryOf<Tracked<…>>` for a `historyOf`), so a handler writes `input.order.orderId`, never `input.order.value.orderId`; who made a value is `Metadata.createdBy(input.order)`. Removed: `Produced`, `ProducedValue`, `{ producer, value }` records (in handlers, routers, arbiters, `testUnit` inputs, recorded inputs of `mockLlm(X).inputs`). `testUnit` takes `Untracked<InputOf<T>>`: a plain DTO literal, tracked by default (the component under test as its creator, the field as its slot), `Metadata.with(dto, { createdBy })` states a producer. The runtime keeps every value's provenance (outdating, slices, joins) unchanged; the input message the model reads is unchanged. A `listOf(A, B)` judge reads items that are instances of their classes.
