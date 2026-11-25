---
section: Breaking
issue: 1318
---

**`agboss check` takes every profile of `src/config/`, and the resume hashes leave out the operational limits** (#1318, part 1318d2).
`agboss check` assembles the application under each profile of the folder, the inactive ones and a duplicate
`<name>.config.ts` + `<name>.config.yaml` included, schema-only: no `defineEnv` variable and no secret is read. A broken
one is a `profile.invalid` problem naming its file. It also writes `.agboss/config.schema.json`, the JSON Schema of a
`.config.yaml` typed by the project (its workflows by name and `"*"`, their agents, its model providers) — use it with
`# $schema: ../../.agboss/config.schema.json`. `agboss dev | studio | rag index | records export | golden add` take `--profile`.

- `configHash` and `modelVersion` no longer read the operational limits: `maxSteps`, `defaults.tools.maxToolCalls` /
  `maxResultSize`, an agent's `maxToolCalls` and `maxRetries`. A retention `ttl` and a provider's fallback, resilience and
  routing were never in them. A paused run therefore resumes under a profile that only tunes them; the hash of every
  workflow changes once, there is no versioning of the old one (0.1.0 runs do not resume).
- `modelVersion` also covers the judges' and the compactions' models.

Added: `profileProblemsOf`, `configJsonSchemaOf` (`@agboss/core/internal`). Not yet: the component shelves (`budgets`,
`memories`, `filePolicies`, …) of a profile.
