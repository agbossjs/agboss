---
section: Fixed
issue: 980
---

**Fault scenario 18 no longer fails once in a while under load** (#980): its follow-up was sent as soon as the task's `INPUT_REQUIRED` was readable, while the first pass still held the tree's lease (a pass announces its rest before it releases, #901), so a drain could take the answer and the resume ended `-32004`. The scenario's task helper now holds that release until the rest is read. A test-side fix of the published fault suite; no change to the application or the stores, no migration.
