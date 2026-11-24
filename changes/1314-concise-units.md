---
section: Added
issue: 1314
---

**Concise unit helpers in `@agboss/core/units`** (#1314): `bytes`, `kb`, `mb`, `gb`, `tb`, `ms`, `sec`, `min`, `days`, `workMin`, `workHours` and `workDays`, beside the existing `hours` and `usd`. Each gives the value of its verbose helper (`sec(30)` is `seconds(30)`); the verbose names (`kilobytes`, `megabytes`, `seconds`, `minutes`, `workingMinutes`, `workingHours`) still work until the flip. `workDays` counts a working day as 24 hours of working time until #1310 gives it calendar semantics.
