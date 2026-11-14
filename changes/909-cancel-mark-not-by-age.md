---
section: Fixed
issue: 909
---

**A cancel's mark is lifted by the retention only once its tree is over** (#909): the fencing stores'
retention sweeps (`deleteByStoredAtBefore`, `deleteByEndedAtBefore`) removed a tree's cancel mark by
age alone, so a tree cancelled and not yet over (a long pause, then a resume on another instance)
could write again after the sweep. A mark is now removed only when it is older than the cutoff **and**
its tree's lease is retired; the mark of a tree never retired, or with no lease row yet, is kept. A
store of your own does the same; the fenced-effect and outbound-call contracts carry the case
("a cancel's mark is not lifted by the retention while its tree has not retired"). No migration.
