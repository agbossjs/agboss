---
section: Breaking
issue: 1288
---

**`variant`, `isVariant`, `Variant`, `PartialVariant`, `VariantOf` and `listOf(oneOf(…))` are gone** (#1288a, flip F1). An action returns a plain object for a `oneOf(…)` or `listOf(A, B)` output (told apart by its strict schema, `[dto.ambiguous-one-of]` at assembly); narrow a value by `item instanceof XDto`, a judge's output by `input.output instanceof XDto`; write `listOf(A, B)` for a polymorphic list. A `listOf(A, B)` judge reads `readonly (A | B)[]` instead of `{ variant, value }` items. In a test, `expect.any(XDto)` matches the class of an element. The internal variant tag of a stored value stays (it hydrates a scope value after a resume).
