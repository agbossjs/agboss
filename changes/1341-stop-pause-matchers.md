---
section: Added
issue: 1341
---

**`toStopWith` and `toCancelWith` matchers** (#1341, part b): `expect(output).toStopWith("enough")` passes
for a run that ended `ExecutionStatus.Stopped` (for that `reason` when one is given), `expect(output)
.toCancelWith()` for one that ended `ExecutionStatus.Cancelled`; both read like `toFinishWith`, name what
the run did instead when they fail, and are registered by `@agboss/core/testing/setup`.
