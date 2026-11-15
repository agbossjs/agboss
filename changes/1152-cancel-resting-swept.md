---
section: Fixed
issue: 1152
---

**A cancel that dies after its durable request but before the record moves is finished by the
sweep** (#1152, #1132, #1117): `app.cancel` writes the tree's cancel mark (on its lease row) before
it moves the root's record, so an instance that died in between left a tree resting `paused` with a
cancel nobody finished — only a retry of the cancel or an answer read it. The orphan look now reads
the mark of every resting root it visits, and a root that carries it is ended as cancelled under the
tree's lease, exactly as `app.cancel` ends it: the same record states and events, the pause closed
so a late answer gets the typed refusal, the children dropped. Two sweeps, or a sweep and a retried
cancel, end it once. A take of a tree's lease (a resume, a recovery, an expiry) now reads the mark
too, so an answer that arrives in that window is refused instead of running the cancelled tree.
`ExecutionLeaseRepository` gains `isCancelRequested(tree)`: a store reads the tree's mark from the
lease row `requestCancel` writes (in-memory and SQLite do; PostgreSQL and MongoDB add it with their
part of #1117).
