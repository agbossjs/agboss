---
section: Breaking
issue: 1292
---

**One cross-field mechanism, `@Validate`, and the DTO helpers are public** (#1292): `@Validate<Dto>((dto) => dto.to >= dto.from || "to is before from")` is a class decorator for a rule across fields (return `undefined`, `true` or `[]` for valid, `false` or a string / `{ field?, reason }` / a list of them for invalid; a check that throws fails closed); a subclass inherits its parents' checks, and the checks run on a nested DTO too. The internal `crossFieldRule` is removed (the standard DTOs use `@Validate`). New: `@KeyText` (a string that is a key under the framework's key rules: 1 to 200 characters, no control, invisible or look-alike characters, NFC; the rule is named, never the text; `minLength`, `maxLength` and `pattern` only narrow it), `validate(Dto, raw)`, `jsonSchemaOf(Dto)` and `maskDto(Dto, value)` in `@agboss/core/dto`. `MoneyDto` now follows the currency's ISO 4217 minor unit (`JPY` 0 digits after the point, `USD` 2, `KWD` 3, `CLF` 4) and refuses a code that is no money (`XAU`, `XXX`, …): its JSON Schema and hash change.
