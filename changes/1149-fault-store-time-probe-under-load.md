---
section: Fixed
issue: 1149
---

**The fault suite's store-time check no longer fails on a loaded host** (#1149): the probe that
measures a store set's clock rate against its declared `storeTime` took the real time between its two
lease reads as one number, so a host that held the calls up read a database-clock set as a host-clock
one. The reading now carries the bracket of real time the store's two reads fall in, and a declaration
is contradicted only when the rate is nearer the other time's span than the declared one's.
