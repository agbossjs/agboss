---
section: Changed
issue: 1356
---

**The takeover, unwind and undo mutation shards kill their mutants** (#1356): the error-family machinery (what a
variant keeps as facts and `details`, its sentence and cause, the reserved fact names, how a family is declared or
refused, how a paid family reads its spend), the cancel hooks of a lease, the unwind of a failed join and of a step's
failure (held entries, the durable order of the tree's undo, a stopped tree, `maxItems` and `skip()`) now have tests
that assert their exact values. Dead code that left equivalent mutants is removed with no change of behaviour: a
`Date` fact with a fallback no `Date` could reach, a type guard whose `null` side the spread already ignored, a
`typeof` check `WeakSet.has` repeated, a length check `some` repeated and a bound read twice. No migration.
