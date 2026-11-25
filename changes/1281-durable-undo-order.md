---
section: Fixed
issue: 1281
---

**The undo order of a tree is durable** (#1281). `CompensationEntry.sequence` is one counter per root tree across the parent and every child at any depth: each place is claimed in the tree's own store (`ExecutionTreeRepository.saveIfAbsentInTree`, key `@agboss/compensation-order/<n>`) before the entry is written in its checkpoint. A resume in a fresh process (a takeover, a restart) no longer starts a child's count from nothing, so a parent's entry, its child's and the parent's next are undone newest first exactly. An entry moved up from a child keeps the place it was written with; a store that fails keeps the process's own place (an entry is never lost).
