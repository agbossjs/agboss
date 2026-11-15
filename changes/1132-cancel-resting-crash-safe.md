---
section: Fixed
issue: 1132
---

**`app.cancel` of a resting tree that dies in the middle leaves no pause open** (#1132, #939): the
cancel dropped the tree's paused run and closed its pauses before it moved the root's record off
`paused`, so an instance that died between the two left a pause `Pending` under a root still
recorded `paused` — the orphan look skipped it and a second cancel found no run. The cancel now
marks the tree unwinding and moves its record first, then drops the run and closes the pauses, so a
death at any point is finished by the recovery sweep, or by a second `app.cancel`, which answers
`true` while it ends the tree itself. A cancel that died before its record moved only left its
request: the tree rests until a retry of the cancel or an answer reads it.
