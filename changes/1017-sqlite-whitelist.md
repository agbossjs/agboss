---
section: Fixed
issue: 1017
---

**SQLite classifies every write by the whitelist rule** (#1017): an autocommit write read through
`get` or `all` (an `UPDATE … RETURNING`) bypassed the classifier, which only wrapped `run`, and an
autocommit write failing with `SQLITE_FULL`, `NOMEM`, `INTERRUPT` or `PROTOCOL` was called known
although it runs the same WAL commit phase as `COMMIT`. A write is now recognised from its prepared
SQL whichever method runs it, and its error is known only for the codes that guarantee nothing was
applied (`BUSY`, `LOCKED`, `READONLY`, `TOOBIG`, `CONSTRAINT`, `MISMATCH`, `MISUSE`, `AUTH`,
`RANGE`); every other code is `StoreOutcomeUnknownError`. Reads are unaffected. No migration.
