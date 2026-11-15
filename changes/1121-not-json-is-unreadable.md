---
section: Fixed
issue: 1121
---

**A stored record whose text is not JSON fails with `StoredNamesUnreadableError`** (#1121): a paused
run, a pause (and its answer column), a pause answer and a history record whose stored text was no
JSON failed with a plain `Error` with no `code`, while one that failed the schema check was
`StoredNamesUnreadableError` (`code: "stored.unreadable"`) — one condition, two error types. Both are
the coded error now, with the record's ids; its `cause` is a `SyntaxError` that keeps no stored text
(the parser's own message quotes it). `parsedStoredJson` (from `@agboss/core/stores`) is what a store
reads a stored text with, so a store's refusal is the core's.
