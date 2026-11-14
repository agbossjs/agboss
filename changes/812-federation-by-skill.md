---
section: Changed
issue: 812
---

**Federation pairs by skill; a foreign `@A2AAgent` is listed, not compared** (#812): `agboss check
--federation`, the Hub CLI and `describe --json` pair an `@A2AAgent`'s `(target.application,
target.skill)` with an export `skill` (the exported start's name) — `application.contracts.exports[]`
of an A2A export has `skill` where it had `start`, `imports[].target.skill` where it had `start`.
An `@A2AAgent` without `target.application` (a foreign A2A agent, typed or not) is listed in
`imports` with `foreign: true` (`target: null`; `input` / `output` `null` when untyped) and skipped
by `check --federation`, which never reports `[federation.missing-target]` for it; every other
import has `foreign: false`. A snapshot saved by 0.1.0 (`start`, no `foreign`) is still read.
Migration: a tool that reads `describe --json` reads `skill` and `foreign`; re-save the
checked-in snapshots (`agboss describe --json > snapshots/<app>.json`).
