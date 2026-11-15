---
section: Fixed
issue: 1090
---

**Recovery no longer reports a tree finished while it still has steps to run** (#1090): when a
holder lost its tree after a task's writes were saved and before the next checkpoint, the next
holder read LangGraph's empty `next` list as "the graph finished", skipped the remaining steps
(a charge never ran), and recorded the run as answered with no error. A graph has finished only
when its checkpoint triggers no task (`tasks` is empty); the next holder applies the saved writes
and runs what is left, once. The same reading is fixed for a remote child's pass, an own-thread
child (whose answered interrupt is no longer read as open) and a read of a resumed tree's output.
A run whose graph stops at no finish node and waits for nothing now fails loudly instead of being
recorded as answered. A new run handed over before its first checkpoint tells its caller that it
did not start (its record ends failed). No migration.
