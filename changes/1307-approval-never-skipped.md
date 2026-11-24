---
section: Security
issue: 1307
---

**A tool's approval is never skipped** (#1307a): a tool that named its approval only with the new `approval` (a `defineTool({ approval })` or a hand-built `Tool`) ran without asking, because the loop read only `channel`. `approval` and `channel` now name the same wait (different names in one definition throw). New pause settings the runtime does not read yet — the `assign` and `resolveTimeout` hooks, `escalationLimits`, a `@ChannelSelector`, a `@Channel({ timeout })` — are refused at assembly with `[pause.setting-not-enforced]` instead of being ignored.
