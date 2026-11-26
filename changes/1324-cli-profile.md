---
section: Changed
issue: 1324
---

**`agboss check`, `describe` and the types need no variable and no key; `--strict` verifies the variables** (#1324, part b CLI) — every command that builds the application takes `--profile <list>` (`--env` is gone from every command, help text and template). The report of `agboss check` lists the process variables of every `defineEnv` reference the application reads, the `deps: [appEnv]` of its agents, tools and services included ("the application needs N process variables:", `not set` where they are), and checks every profile of `src/config/` schema-only, the inactive ones too (`[profile.invalid]`). `agboss check --strict` fails with `[environment.missing-variable]` on a required variable the process does not set (a secret's only together with `--models`). The check and `describe` build the tools with a placeholder for an unset required value (empty text, 0, false) and an unresolved secret; no output, error or JSON report of either carries a value.
