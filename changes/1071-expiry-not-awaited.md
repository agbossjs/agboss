---
section: Fixed
issue: 1071
---

**An expiry's continuation no longer runs inside the pause timers' tick** (#1071, #941): the expiry
look starts each root's expiry (the channel's handler and the pass that goes on after it) and moves
on, at most `maxConcurrentSteps` at once, as the recovery sweep starts its recoveries. A long step
after an expiry no longer makes `app.checkLiveness()` report `pause-timers` stuck, and other due
pauses are asked near their own deadlines. `app.close()` still waits for the expiries in flight. No
migration.
