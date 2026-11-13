---
section: Fixed
issue: 939
---

**A resend of an accepted follow-up whose reply was lost gets the task, not `a2a.task-over`** (#939):
when the kept reply of a follow-up was lost (a failed write, a crash) and its task had finished since,
the resend was refused as `-32004 a2a.task-over`, and that refusal was kept — though the answer had been
taken and charged. A resend is now told apart by its kept message, not by the task's state: it gets the
task as it is (also for a lost `pause-closed` refusal whose task was cancelled since), and nothing is
charged again. A NEW message to a finished task is still `a2a.task-over`. No migration.
