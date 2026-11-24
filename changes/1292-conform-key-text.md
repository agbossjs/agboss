---
section: Breaking
issue: 1292
---

**`@KeyText` takes only `[a-zA-Z0-9._:-]`, `KeyTextOptions`** (#1292, conformance) — a key text is safe as a URL segment, an object-store key and a log key: spaces, `/`, `?`, `#`, `%`, quotes and look-alike letters are refused, on top of the framework's key rules (length, NFC, no invisible characters).

- **Removed:** `KeyTextLimits` (renamed).
- **Added:** `KeyTextOptions` (`minLength`, `maxLength`, `pattern` narrow the key).
- **Changed:** `@KeyText` fields refuse any character outside `[a-zA-Z0-9._:-]`; the issue names the rule, never the text.
