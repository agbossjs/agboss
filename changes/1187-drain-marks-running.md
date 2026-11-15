---
section: Fixed
issue: 1187
---

**A tree whose holder dies after its rest, while it takes an answer recorded meanwhile, is continued**
(#1187): a drain whose pass rested (its record written `paused`) and went on with an answer recorded
during that pass ran its next pass with the record still `paused`; a holder killed in that pass
left a tree no recovery continued (only `running` records are) and no resume could move (its pause
was no longer pending) — stuck, never charged, never ended, on every store (a resume waiting on
another instance read it as paused and returned a stale paused result). The drain now marks the
record `running` before it takes the answer, and the recovery sweep's look at the open pauses wakes
a `paused` root beside an answer no pass took — under the tree's lease, the answer still untaken —
for recovery to continue, the answer taken once. No migration.
