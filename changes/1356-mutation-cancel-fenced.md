---
section: Changed
issue: 1356
---

**The cancel, lost-lease and fence modules are mutated at 100 %** (#1356): the new `cancel` shard of
`packages/agboss/stryker.config.mjs` mutates the cancel of a thread and of a resting tree (its durable mark, a paused tree's
undo and end, the sweep of a request that died half way, a request on another instance) and what a lease reports and
releases when it is lost; the `fenced-reach` shard mutates the fenced effects a component injects (#890), the execution's
fence a step reads and the components that reach a writer under business keys. No behaviour changes. No migration.
