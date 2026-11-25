---
section: Changed
issue: 1320
---

**A federation snapshot written before 0.1.1 is refused by name** (#1320): `agboss check --federation` and the hub, handed a `describe --json` file that still has an export's `expose`, an `@A2AAgent` import's `price` or an MCP import's `target.expose`, say it was written by agboss before 0.1.1 and to re-run `agboss describe --json` (0.1.1 renamed `expose` to `endpoint` and `price` to `costPerCall`), instead of a schema message about a missing field.
