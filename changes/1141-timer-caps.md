---
section: Fixed
issue: 1141
---

**Every timer-backed duration setting has a documented maximum** (#1141): a value above 2^31 − 1 ms
made Node fire the timer at once (a shutdown that gave up immediately, an undo that timed out
immediately). `shutdownTimeout`, `compensationTimeout`, `outboundCalls.attemptTimeout`, a tool's, a
health check's and a model provider's `timeout`, a retry policy's delays, `fileFetchTimeout`, an A2A
call's `timeout` and `app.close({ timeout })` are refused above 24 hours; `maxTaskDuration`, a
quorum's `deadline` and `execute({ deadline })` above 24 days — each naming the field (the table is
on the Wiki's Configuration page). The system `Clock` also waits out a longer delay in parts. A value
that long was never working; no other value changes.
