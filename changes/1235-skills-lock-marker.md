---
section: Fixed
issue: 1235
---

**The skills sync lock no longer sticks when the clock was set back after a check had seen it** (#1235, follow-up of #1105): the marker a waiter leaves in a lock it cannot judge by time (`seen-future`) was itself dated ahead when the clock was ahead as it was written, so it counted as nothing and was never rewritten, and every `agboss check` waited 12 s and skipped until the clock caught up. Lock aging is now monotonic and self-healing: the marker records the host's monotonic time besides its own mtime, and its age is the shorter of the two, so a clock set forward cannot age a lock early and one set back (or a reboot) cannot freeze it. A marker or lock dated ahead of this clock by more than a minute is untrusted: the marker is rewritten to now, and the lock is taken `staleMs` of real time after. A live holder on this host whose start fits is still never taken. No migration.
