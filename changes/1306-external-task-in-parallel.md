---
section: Added
issue: 1306
---

**`toExternalTask(…)` in parallel launches** (#1306). A committee of external parties signs side by side
(`.inParallel([toExternalTask(Legal), toExternalTask(Security), …])`) and a list of owners is asked one
external task per item (`.forEachItem(toExternalTask(Owner), { maxItems })`), both followed by
`.arbitratedBy(…)` and `.joinQuorum(…)` / `.joinQuorumGroups(…)`: every branch is its own pause, only an
approving answer counts, and the pauses left open are withdrawn once the quorum is decided.
