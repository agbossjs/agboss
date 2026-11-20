---
section: Fixed
issue: 1353
---

**A `Stryker disable` hides exactly one equivalent mutant on the money, takeover and streaming paths** (#1353, #619): a disable on a line also hid the mutants that were not equivalent — `if (false)` on the pruned-mark guard of both cost ledgers (#771), the held usage chunk of a streamed answer, the empty-`try` and empty-function-body mutants of six JSON readers, the 8 and 7 mutants of the two token patterns of the stream's unmasker, the dropped `signal`, `usage_metadata` and `id` of a fallback's streamed answer. Each such line is rewritten (a tested helper, an operand on its own line, the `try`/`catch` ending in `return undefined`) so no disable is needed or exactly one equivalent mutant sits under it, and each newly visible mutant is killed by a test. No behaviour changes; no migration.
