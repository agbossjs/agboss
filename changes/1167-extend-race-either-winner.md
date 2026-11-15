---
section: Fixed
issue: 1167
---

**The contract case "two concurrent extends from one read" holds for either winner** (#1167) — the
case assumed the longer extension is applied first, which is true of the in-memory and SQLite stores
(calls in order) and false of a store whose two instances race for real: MongoDB failed it in most
runs, the shorter one winning and the longer one's retry from the stored deadline then going through
as the contract says it must. The case now expects exactly that for either winner; the rule it states
is unchanged. A store author's `storeConformance` run needs nothing.
