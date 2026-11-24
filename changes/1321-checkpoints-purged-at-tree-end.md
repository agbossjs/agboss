---
section: Breaking
issue: 1321
---

**An ended tree's checkpoints are deleted with it** (#1321d, Q11): `forgetTree` removes the root's checkpoint thread and every child thread (`<root>/child/<id>`, at any depth) through the application's saver, so `deleteThread(rootExecutionId)` of a saver now removes the whole tree and only it (the checkpoint saver contract has a case). A finished tree is read from its kept record alone: `DurableExecutionStatus.Finished` read from an answered record has the finish of its route's last node and its cost, no output and no tokens; the A2A task projection takes the finish and output from its end event. A tree whose end is still being recorded (record not yet answered) is still read from its last checkpoint.
**Store follow-up (T-train):** a saver of a store package overrides `deleteThread` to also remove the threads `thread_id >= '<id>/child/' AND thread_id < '<id>/child0'` (PostgreSQL with `COLLATE "C"`, created after `PostgresSaver.setup()`, not in a numbered migration; MongoDB and Redis by prefix).
