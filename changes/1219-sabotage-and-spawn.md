---
section: Fixed
issue: 1219
---

**The S2a sabotage waits for its own effect, and a scenario that fails otherwise is not reported as a
passing sabotage** (#1219, #1228): the S2a case ("a store that never answers, the payment sent again")
let pod b take over and end the tree without waiting for pod a's second charge, so on a loaded
machine, with a's timers starved, a's late charge could come after b or after the check and the
sabotage went uncaught; it now waits for a's resent payment first. `sabotaged` now reports a scenario
that failed on something other than an invariant (a wait that ran out, a pod that died) with its own
error instead of "the sabotage passed — the suite does not bite". The `generate.test` check:types
spawn carries a 240 s bound (4.9 s alone, over 60 s in a full run beside the fault suite).
The `fenced-effect-sqlite` and `cancel-resting-sweep` suites got a 60 s case bound too (0.1-0.15 s a case alone, 4.4-6.6 s once in a loaded run).
