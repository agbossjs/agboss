---
section: Changed
issue: 1376
---

**The mutation shards' table is short again, and its lint limit is back** (#1376): the inline shards of
`stryker.config.mjs` moved to `scripts/stryker-ranges-core.mjs` and `stryker-ranges-a2a.mjs` as functions, like the
newer groups', and the `max-lines: off` override of `eslint.config.js` is gone. No shard changed.
