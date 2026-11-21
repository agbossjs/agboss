---
section: Fixed
issue: 1375
---

**A synchronous throw of the turn store's `byIds` no longer replaces the drain's error after an expiry** (#1375): the
read that tells whether a rejected drain ended the run (`endedByRun`) swallows any failure of the read again — a
store that throws before it returns a promise (the SQLite turn store, `node:sqlite`), a null record, no list — and the
error the look raises is the drain's, as its doc says. A rewrite of #1370 had answered only an asynchronous rejection.
