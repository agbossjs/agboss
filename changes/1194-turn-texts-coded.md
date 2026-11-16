---
section: Fixed
issue: 1194
---

**The SQLite turn store's stored texts that are not JSON fail with `StoredNamesUnreadableError` too**
(#1194, after #1166): a turn's task, answer, stop reason, route and steps, and a summary's text were
parsed with a plain `JSON.parse`, so a corrupt row threw a `SyntaxError` with no `code` whose message
quotes the stored text (PII in logs and spans, #906 D4-b). It is the coded error now
(`code: "stored.unreadable"`, the record and the row's ids). `parsedStoredJson` and the error moved
to the core's leaf layer (`src/core/stored-json.ts`); `@agboss/core/stores` exports them as before.
