---
section: Fixed
issue: 1093
---

**A pending public call keeps the process alive** (#1093, #941): `app.cancel` of a tree another
instance holds, `app.resume`, `app.execute`, `app.close()` and `app.checkReadiness()` wait on timers
that do not keep Node running, so in a script that only made the call the process exited with code
13 in the middle of it. Each call now holds a handle until it settles and releases it in `finally`;
an idle application is as killable as before. No migration.
