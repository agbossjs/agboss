---
section: Fixed
issue: 1297
---

**The A2A file-fetch share named `maxConcurrentFileFetchesPerTenant` is a tenant's now, not a tenant-and-owner's** (#1297, found by the acceptance of #1256): each owner of a tenant had its own quarter of the slots, so one tenant with many owners took every slot and the whole queue, and every other tenant was refused `a2a.file-fetch-busy`. The shares are two levels now: a tenant holds at most `maxConcurrentFileFetchesPerTenant` of `maxConcurrentFileFetches` (a quarter by default, at least 1) and four queue places per slot of it, however many owners it has; inside it each owner holds at most the new `a2aHttpListener({ maxConcurrentFileFetchesPerOwner })` (a whole number from 1, `[a2a.file-fetch-limit-invalid]`; a quarter of the tenant's share by default, at least 1) and four queue places per slot of that. A caller with no owner is its tenant's one anonymous owner. A fetch over either share is refused at once (`a2a.file-fetch-busy`). With the defaults (16 slots) a tenant runs 4 fetches and an owner 1, where an owner ran 4 before.
