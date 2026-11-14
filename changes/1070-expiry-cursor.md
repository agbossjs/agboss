---
section: Fixed
issue: 1070
---

**Due pauses nobody here can move no longer starve the ones behind them** (#1070, #1072, #941): the
expiry look reads the due pauses page by page with a keyset cursor `(deadline, tenantId, pauseId)`
within a sweep, and starts again from the earliest at the next one, so 50 or more pauses of another
application's trees, of a removed workflow, of an incompatible version or of trees in use no longer
hide a later deadline. Custom `PausedExecutionRepository` stores: `findPendingByExpiresAtBefore(at,
limit, after?)` takes the optional `after` keyset (`PauseScanAfter`: the last pause of the page
before, `{ at, tenantId, pauseId }`) and returns only the pauses past it in the same order; the
contract cases check it.
