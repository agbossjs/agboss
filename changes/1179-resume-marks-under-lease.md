---
section: Fixed
issue: 1179
---

**A resume's `running` mark can no longer land on a tree that already rests again** (#1179): a
resume wrote its record `running` once more before it held the tree's lease. A holder that had taken
its answer meanwhile, run the step and rested the tree at its next question had already written
`paused`; the late write turned the record back to `running` while the tree waited at an open
pause. The write is now made under the lease, only when an answer is there to take. No migration.
