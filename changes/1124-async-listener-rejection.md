---
section: Fixed
issue: 1124
---

**An `async` `onStream` listener that rejects no longer crashes the process** (#1124 acceptance):
its rejected promise was dropped and Node's default `unhandledRejection` handler killed the process
mid-run, with nothing logged. A listener whose returned promise rejects is now handled like one that
throws — the run goes on and the first failure of a run is logged once as `stream.listener-failed`
(the error's class only) — for `onStream` and for the A2A streaming fan-out alike. The listener is
not awaited; the type and the README say so.
