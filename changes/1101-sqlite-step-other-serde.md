---
section: Fixed
issue: 1101
---

**SQLite: a checkpoint saver whose serde names its metadata type anything but `json` no longer
answers `latestByStep` by id** (#1101, a regression of #1035): the generated `step` column reads
`metadata.step` from JSON only, so every checkpoint written by an encrypting or otherwise renamed
serde sat at step -2 and the greatest id won, which is the wrong checkpoint on a marked thread.
`latestByStep` now finds, with one probe of a small partial index, whether the thread's namespace
holds a row whose metadata is not `json`; if it does, it reads each row's step through the saver's
own serde and answers what the scan answers. Every other thread keeps the one-walk indexed read.
