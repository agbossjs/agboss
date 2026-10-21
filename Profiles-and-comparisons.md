# Profiles and comparisons

Compare configurations of a workflow on the same tasks — without committing a code change.
Decision: [ADR-0008](ADR-0008-Declarative-profiles-and-explicit-versions).

## Versions

Every workflow config has an explicit `version` (e.g. `1.0.0`). Every run (Tern) stores it together
with a hash of the resolved config + prompts, and the first run of a version keeps a full snapshot.
Same version, different content → a warning on start:

```
warning: config "job-scout" 1.0.0 changed without a version bump (hash 3f2a…)
```

## Profiles (Spring-Boot-like)

`profiles/<workflow>/<profile>.yaml` lists only what differs from the TypeScript base:

```yaml
# yaml-language-server: $schema=../../schema/profile.schema.json
profile: scout-low-thinking
version: 1.0.0-low-thinking # required, must differ from the base
agents:
  scout:
    thinking: low
prompts:
  scout: { file: scout-strict.md } # or inline text; replaces the agent's prompt
```

- Overridable: `defaults` (`uncompactedTurns` among them), `compactions.<name>` (its model,
  `turnsBetweenCompactions`, `summaryQueueLength`), `agents.*` (any field, any depth), `prompts`. The flow,
  its routers and the limits are code (`@Workflow({ flow, maxSteps })`, the application's
  `@Budget`s) — not profile keys (#116).
- Objects merge key by key; arrays and scalars replace. The merged config is validated again.
- Typos and unknown agents fail with the file and the key (`profiles/…yaml: agents.coder.thinkin: …`).
- `schema/profile.schema.json` is generated from the zod schema (`npm run schema`; a test fails
  when it is stale) → autocomplete and validation in editors with the YAML language server.

Use a profile anywhere: `agboss chat --profile scout-low-thinking` (also `agboss run`,
`agboss eval`, `agboss replay`, `agboss compare --profiles`; in job-scout `npm run chat -- --profile <name>`). `base` means no profile.

## Golden sets

`golden/<workflow>/<name>.yaml` — tasks kept for reproducible comparisons:

```bash
npm run golden -- add --name core --from-last 20   # last 20 real tasks (--start <name> with several starts)
```

## Compare

```bash
npm run compare --profiles base,scout-low-thinking --golden core
npm run compare --profiles base,scout-low-thinking --last 20
```

```
profile            | version            | mean | vs base (w/l/t) | cost    | per task | p50 s | p95 s | failed
base               | 1.0.0              | 0.50 | baseline        | $0.0141 | $0.0071  | 30.6  | 35.8  | 0
scout-low-thinking | 1.0.0-low-thinking | 0.62 | 1/0/1           | $0.0115 | $0.0058  | 21.7  | 33.5  | 0

scout-low-thinking vs baseline:
  agents.scout-agent.thinking: "none" → "low"
```

- Each task runs as a first contact on every profile.
- **mean** — Jev's P(adequate); **vs base** — per task Jev picks the better of the two answers
  (A/B order randomised; an unsure verdict is a tie).
- Everything runs within the application's budgets (#261): the comparison stops cleanly once a
  tenant or application budget is exhausted ([FinOps](FinOps#eval-spend)).
