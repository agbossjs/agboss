---
section: Fixed
issue: 954
---

**An `execute()` or `resume()` the shutdown gives up on settles, and the stop logs nothing after it returned** (#954, after #923): when `close({ timeout })` reached its end with a run still waiting for a store that did not answer, the run was left behind and its caller's promise stayed pending for ever (or, once the connection was destroyed, rejected with the driver's raw error, such as node-redis's `Disconnects client`). The caller now gets an `ApplicationStoppingError` (`app.stopping`) at the end of the shutdown timeout: the run is given up, it stays `running`, and the next take of its lease (another instance, or this application when it starts again) continues it. The late answer or failure of the abandoned work is dropped. The warning `app.step-still-running` for a step body still running at the end of the stop is now logged before `close()` returns, never after it (it came when the abandoned work finally returned, sometimes minutes later).
