---
section: Changed
issue: 1225
---

**The unit project's default test and hook timeout is 20 s** (#1225): 5 s only caught a slow machine
(ordinary cases ran 5-11 s in a loaded full gate and failed, eight files at a time), while 20 s still
catches a hang. A test that asserts a timing keeps its own tighter bound. The fault project and the
mutation configs are unchanged.
