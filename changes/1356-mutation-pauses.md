---
section: Changed
issue: 1356
---

**The `pauses` mutation shard is at 100 % locally** (#1356): the permission hooks of a pause's target (what each is told, how a throw, a rejection, an unresolvable target and any value but `true` refuse), the reassignment's plan, deadline, limits and expiry, the timeout change and its request, every `Invalid Date` refusal with its field and record, and the shapes of the pause records (stored JSON, the log entry, the replacement and the timeout change's chain entry) are pinned with exact values. Three equivalent-mutant rewrites: `isReached(count, max)` replaces three `max !== undefined && count >= max` tests, the replacement's dropped keys are two named lists, and the canonical instant text is the `toISOString()` length (24) plus its round trip instead of a regex whose anchors the round trip made redundant.
