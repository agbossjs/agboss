---
section: Fixed
issue: 1256
---

**An A2A listener fetches at most 16 files by url at once, across all messages** (#1256, after the
review of #1241): `FileFetches` joined only the duplicates of one message, so K messages of
`maxFiles` urls to a slow origin held `maxFiles × K` TLS sockets for the fetch timeout. A fetch now
takes a slot of the listener's `a2aHttpListener({ maxConcurrentFileFetches })` (a whole number from
1, `[a2a.file-fetch-limit-invalid]`; 16 by default); without one it waits in a queue of four per
slot, its wait counted in `fileFetchTimeout`, and past the queue it is refused at once
(`-32602`, `a2a.file-fetch-busy`) — nothing grows without a bound. One tenant holds at most
`maxConcurrentFileFetchesPerTenant` of the slots (a quarter of them by default, at least 1) and four
queue places per slot of its share: a tenant over its share is refused at once, so one caller's flood
leaves the others their turn.
