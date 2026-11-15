---
section: Fixed
issue: 1144
---

**One step-less row no longer makes SQLite's `latestByStep` read the whole namespace** (#1144): a row whose SQL step reads -2 (metadata without a step, a type the default serde does not name, bytes a wrapping serde wrote) sent every latest read to a full load of the namespace with its checkpoint blobs (1M rows: 8.7 s, +4 GB per call). The read now takes the index's newest row among the readable ones, decodes only the rows at -2 through the serde, ranks them together as before, and reads the winner's whole row. The answer is unchanged. No migration.
