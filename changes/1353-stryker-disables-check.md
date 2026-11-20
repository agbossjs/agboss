---
section: Changed
issue: 1353
---

**`npm run check` fails a `Stryker disable` that hides more than one mutant** (#1353, #619): `scripts/stryker-disables.mjs` (run by `check:suppressions`, on the `@stryker-mutator/instrumenter` Stryker itself uses, under a second) accepts only `// Stryker disable next-line <Mutator>: <reason>` — no `disable all`, no range, no `restore` — and only when exactly one mutant sits on the next line; a file's ignored mutants must be its disables. The A2A file path, the A2A task store's pages and keys, the client's transport and echo, the server's admission, the held lease and the clock were rewritten so each disable left hides one equivalent mutant, and each mutant it used to hide that was not equivalent is killed by a test. No allowlist; no behaviour changes; no migration.
