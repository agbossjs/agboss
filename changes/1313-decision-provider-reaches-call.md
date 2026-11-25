---
section: Fixed
issue: 1313
---

**A model guardrail and a router's launch decision on a decision model name their provider** (#1313): a guardrail (or a router's launch decider) on a decisions provider of its own, in an application whose `modelProvider` differs, failed `[model.missing-provider]` on its first call: the yes / no decision did not carry the provider its cascade resolved. No migration.
