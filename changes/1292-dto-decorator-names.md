---
section: Breaking
issue: 1292
---

**The DTO field decorators are renamed, and `@Enum` / `@List` take their values first** (#1292): `@OneOf({ values: [...], ...options })` → `@Enum([...], options?)`, and `@Enum(StatusEnum, options?)` takes a string `enum` object directly (the field's type is the enum); `@ListOf` → `@List` (its field may be `T[]` or `readonly T[]`; `ListOfFactory` → `ListFactory`), which also takes an enum's values (`@List(Status)`, `@List(["a", "b"])`); `@Date` → `@IsoDate`, `@DateTime` → `@IsoDateTime`, `@Duration` → `@IsoDuration` (the field is still ISO text), `@Decimal` → `@Float` (a floating-point `number`; `@DecimalString` is the exact one), `@Flag` → `@Bool`. `OneOfOptions` → `EnumOptions`. The JSON Schema every renamed decorator gives is unchanged. The old names are removed: rename them in your DTOs (`@OneOf({ values: ["a", "b"], prompt })` becomes `@Enum(["a", "b"], { prompt })`).
