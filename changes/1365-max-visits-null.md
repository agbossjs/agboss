---
section: Fixed
issue: 1365
---

**A node whose `maxVisits` is `null` is refused on its first visit again** (#1365): options from untyped code or parsed JSON that carry `maxVisits: null` reach the runtime node, and the analysis counts it as a bound. Since 0.1.1's rework the run took it for no bound, so a cycle the analysis passed looped up to `maxSteps`, each visit a paid model call. The guard holds `null` to a bound of 0 as it did before, and fails closed. A node with no `maxVisits` is still held to none.
