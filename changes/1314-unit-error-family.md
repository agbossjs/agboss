---
section: Breaking
issue: 1314
---

**Unit errors are `ConfigError.Unit`** (#1314): `UnitError` and the `PlainErrorOptions` re-export of `@agboss/core/units` are removed; a value out of range throws `ConfigError.Unit` (`config.unit`), an `AGBossError`.
