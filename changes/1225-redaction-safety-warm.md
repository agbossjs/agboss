---
section: Fixed
issue: 1225
---

**Main's CI names a failing test in a sharded run, and the first sharp render no longer times out**
(#1225 follow-up): `coverage:shard` runs the `default` reporter beside `blob`, so a shard's failure is
readable in the job log instead of only in the blob. The first case of `redaction-safety` (the first
text rendered by sharp, which loads librsvg and builds the fonts' cache) timed out at 5 s on CI's clean
runner (run 43916824156, `tests (unit 2/6)`); a `beforeAll` now warms it under a 60 s bound.
