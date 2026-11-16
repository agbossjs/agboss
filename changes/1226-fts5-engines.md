---
section: Fixed
issue: 1226
---

**`engines.node` is `>=22.16.0`, and `SqliteFtsConnector` fails closed without FTS5** (#1226): `node:sqlite` of Node 22.13, 22.14 and 22.15 has no FTS5 module ("no such module: fts5"), which the connector needs, so the former `>=22.13` was false for it. `@agboss/core` and `@agboss/cli` now require Node 22.16 or later. On a Node without FTS5 (an install that ignores `engines`) the connector's first `retrieve` or `index` throws `RagFts5UnavailableError` (`rag.fts5-unavailable`), naming the Node it needs, instead of SQLite's raw error; nothing is written to the index file.
