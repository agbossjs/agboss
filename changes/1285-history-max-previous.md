---
section: Breaking
issue: 1285
---

**`historyOf(Dto, { limit })` is `historyOf(Dto, { maxPrevious })`** (#1285): the option caps only
the `previous` array of `HistoryOf<T>`, not `current` plus `previous`, and every other cap in the
framework is a `max*` name. `HistoryOptions.limit` and `HistoryWrapper.limit` are now `maxPrevious`;
the rule `[input.history-limit]` is `[input.history-max-previous]`; the described shape of a
`historyOf` field reads `historyOf, maxPrevious 2`. The old `limit` option is gone with no alias: in
TypeScript it is a compile error, so rewrite `{ limit: 2 }` as `{ maxPrevious: 2 }`.
