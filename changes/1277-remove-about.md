---
section: Breaking
issue: 1277
---

**`{ about }` and `[io.ambiguous-cycle]` are removed** (#1277). `.returns(X, { about })`,
`caseOf(X, { about })` and `ReturnsOptions` are gone: `.returns(value)` takes one value and
`caseOf(X)` takes its class. A review loop or any cycle of values built from each other needs
nothing written: a new value outdates what was built from the old one, and `[input.outdated-on-path]`
still refuses every stale read on every path. Removed: the rule codes `io.ambiguous-cycle`,
`io.ambiguous-about` and `io.about-on-start`; `ScopeValueRecord.about`, `EdgeValueSnapshot.about`
(`agboss describe --json`) and the `about` section of `agboss describe`; `OutdatedReason.AboutReplaced`,
so a value outdated through a rewritten value it was built from is `OutdatedReason.BuiltFromReplaced`
and the trace sentence reads `built from X`. A stored `about` field or an `"about-replaced"` reason
of a 0.1.0 record is not read.
