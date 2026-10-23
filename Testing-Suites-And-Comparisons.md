# Suites and Comparisons (A/B testing)

How good is a change of prompt, model or settings? AGBoss compares **profiles** — named
overlays of the workflow's settings ([Profiles and comparisons](Profiles-and-comparisons)) — on the
**same tasks**, and scores the answers with a judge. The tasks come from a golden set (real tasks
you saved) or from the latest runs.

## Concepts

- **Tasks** — what each side runs: a golden set (`agboss golden add`) or the last N tasks of the
  workflow's Terns.
- **Profiles** — the sides of the comparison: `base` (the workflow as written) and any
  `profiles/<workflow>/<name>.yaml`.
- **Judge** — Jev scores every answer, and compares the sides pairwise.
- **Report** — per profile: mean score, pairwise wins / losses / ties against the first profile,
  cost (total, per task), latency (p50, p95), failures, and the settings that differ.

## From the command line

```bash
npx agboss golden add --start chat-workflow-start --name smoke --from-last 20
npx agboss compare --start chat-workflow-start --profiles base,scout-low-thinking --golden smoke
npx agboss compare --profiles base,cheap-router --last 10   # --start may be omitted: job-scout has one start
```

In `examples/job-scout`: `npm run golden -- add --name <n>` and
`npm run compare -- --profiles base,<p> --golden <n>`. A comparison pays from the workflow's eval
account, never from the production day ([FinOps](FinOps#eval-spend)).

## From code — `compareProfiles`

<!-- snippet-context
declare class JobScoutApplication {}
declare class ScreeningWorkflowStart {}
-->

```ts
import { compareProfiles } from "agboss";

const comparison = await compareProfiles(JobScoutApplication, {
  start: ScreeningWorkflowStart, // the workflow this start opens is compared
  profiles: ["base", "scout-low-thinking"],
  tasks: ["Find senior backend jobs in Haifa", "Save the first two jobs"],
});

for (const profile of comparison.profiles) {
  const pairwise = profile.pairwise
    ? `${String(profile.pairwise.wins)}/${String(profile.pairwise.losses)}/${String(profile.pairwise.ties)}, flips ${String(profile.pairwise.positionFlips)}`
    : "—";
  console.log(
    `${profile.name}: score ${String(profile.meanScore ?? "—")}, wins/losses/ties ${pairwise},`,
    `$${profile.costPerTaskUsd.toFixed(4)} per task, p95 ${String(profile.latencyP95Ms ?? "—")} ms`,
  );
}
console.log(comparison.warnings);
```

`compareProfiles` takes an `@Application` and one of its starts (#396 PR 5: the workflow is assembled
as `createApp` assembles it — the application's providers, defaults and environment; a class that is
not one of its starts is refused) and the same options as `createApp` (a scripted `gateway`,
`processEnv`, `env`, …), so a comparison runs in a test without a model or network. Each pair is
judged in both orders ([Profiles and comparisons](Profiles-and-comparisons#compare)).

## With recorded runs

A comparison of recorded behaviour runs in tests with VCR cassettes: record the baseline once and
replay it ([Testing → VCR](Testing)).
