---
section: Breaking
issue: 1292
---

**`DtoValidationError` is `ValidationError.DtoInvalid`; `DtoError` is `ConfigError.Dto`** (#1292, #1325): data that does not fit a DTO (`validate(Dto, raw)`, a start's input, an `app.execute` or `app.resume` request, a pause query, a context value, a tool's arguments) throws `ValidationError.DtoInvalid` (`ValidationErrorKind.DtoInvalid`, code `validation.dto-invalid`, with `dto` and `issues: readonly DtoIssue[]`); it was `DtoValidationError` (`dto.invalid`). A DTO class that cannot be used (an undecorated field, no plain data, a cycle, missing decorator metadata) throws `ConfigError.Dto` (code `config.dto`, its reason leading the message); it was `DtoError` (`dto.undecorated-field`, `dto.not-plain-data`, `dto.no-metadata`, `dto.cyclic`). `DtoValidationError`, `DtoValidationErrorOptions`, `DtoError`, `DtoErrorCode` and `DtoErrorOptions` are removed from `@agboss/core` and `@agboss/core/dto`; `DtoIssue` and `ValidationError` stay in `@agboss/core/dto`. An A2A server's `-32602` reply keeps its wire code `dto.invalid`.
