---
section: Breaking
issue: 1328
---

**`VcrMode` is PascalCase with kebab-case values** (#1328): `VcrMode.Auto = "auto"`, `Record = "record"`, `RecordStale = "record-stale"`, `Replay = "replay"`; `AGBOSS_VCR_MODE` takes those values (`AGBOSS_VCR_MODE=record-stale npm test`). The deprecated `VCRMode` alias is removed. Cassettes keep their format; nothing to re-record.
