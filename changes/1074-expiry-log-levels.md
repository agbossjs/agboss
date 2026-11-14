---
section: Fixed
issue: 1074
---

**A run that ends after its pause expired is not warned about** (#1074, #941): the run deadline
reached after an expiry and an uncaught `fail()` of the expiry end the run as its record and
`onExecutionError` say, so `pause.expiry-failed` is no longer logged for them; it stays a warning for a
real failure of the expiry machinery. No migration.
