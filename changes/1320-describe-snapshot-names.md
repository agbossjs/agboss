---
section: Breaking
issue: 1320
---

**The contract snapshot of `agboss describe --json` says `endpoint` and `costPerCall`** (#1320, #1322, #1324): in `application.contracts`, an export's `expose` is `endpoint` (`A2AExportContract`, `McpExportContract`), an `@McpServer`'s `target.expose` is `target.endpoint` (`McpImportContract`), and an `@A2AAgent`'s `price` is `costPerCall` (`A2AImportContract`, `A2AForeignImportContract`; a USD amount or `null`). `agboss check --federation` reads the new names only: a snapshot written before, with `expose` or `price`, is refused as `[federation.snapshot-schema]` — write it again with `agboss describe --json`. The Mesh Hub's federation view reads the same names.
