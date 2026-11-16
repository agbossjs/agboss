---
section: Fixed
issue: 1140
---

**A single delta over 1 MiB no longer drops an A2A stream subscriber** (#1140): a transport provider's
whole answer is one delta, and one larger than the subscriber's bound ended the stream of a reader that
was keeping up (`stream.subscriber-dropped`). A delta that finds nothing waiting is always taken, and a
large delta is queued as chunks of at most 16 384 characters, so no frame is larger than a chunk; a reader
that is already behind is still dropped at its bound.
