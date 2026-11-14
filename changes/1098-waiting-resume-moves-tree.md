---
section: Fixed
issue: 1098
---

**A resume that waited for a tree's lease moves the tree on when its holder lost it mid-pass**
(#1098): when the holder that took the answer lost the tree after the answered step's writes were
saved and before the next checkpoint, a second `app.resume` waiting on another instance took the
lease, found no answer left to take and returned a stale `paused` result (or `NotPausedError`)
with nothing pending, leaving the tree to the recovery sweep. It now continues the tree from its
checkpoint, as recovery would — the saved writes applied, the remaining steps run once — and
returns where the tree got (finished, or paused at its next pause). A tree that rests at an open
pause is still only read, never moved. No migration.
