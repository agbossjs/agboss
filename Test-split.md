# The test split — scripts, then evaluation, then smoke

Three layers, each checking what the one before cannot (#262 AC15). **No test calls a real
model**: real models answer only in evaluation and in the smoke tests, never in `npm test`.

| Layer | What it checks | How | Models |
| ----- | -------------- | --- | ------ |
| **Unit and application tests** (`*.test.ts`, `npm test`, CI) | your code: the paths a run takes, what a step receives, its errors, limits and their `.onError` paths, a race, a component on its own | `testWith(App)` with scripts (`mockLlm(X).thenReturn(…)`, `when(…)`), `mockOf`, `TestConcurrency`, the unit runners (`testTool`, `testRouter`, …) — [Testing](Testing) | scripted: free, offline, the same every run |
| **Evaluation and golden sets** (`npm run eval`, `npm run replay`, `npm run golden`, `npm run compare`) | the models' behaviour: whether an agent obeys its prompt, picks the right `oneOf` variant, stops at the right depth; whether a prompt or a profile is better | stored Terns scored by a judge, a golden set replayed under two profiles — [Terns and evaluation](Terns-and-evaluation), [Suites and Comparisons](Testing-Suites-And-Comparisons) | real, from the workflow's eval account |
| **Smoke tests** (`make smoke`, never in CI) | what only a provider tells: real prices, rate limits, timeouts, a model's actual capabilities | a handful of real calls in `tests/smoke/`, with a key in `.env` | real, budget-capped |

- A script is not a model: it proves that **your code** does the right thing with an answer, not
  that a model gives it. Whether it gives it is the evaluation's question.
- What a model would do with a prompt is never asserted in a unit test; what a step **sent** is
  (`mockLlm(X).requests`, `toHaveBeenAskedWith`).
- Observer events are tested with a test observer (`@Application({ observers })` in a test
  application); the Langfuse UI is not tested.
- Recorded runs ([VCR](Testing#vcr--recorded-runs)) sit between the first two layers: answers
  recorded once from real models, replayed offline — an integration test, not an evaluation.

**Standalone examples with symmetric Spring-style `tests/` mirroring `src/`:** [`01-hello-agboss`](https://github.com/agbossjs/agboss-examples/tree/main/01-hello-agboss), [`03-support-refund-desk`](https://github.com/agbossjs/agboss-examples/tree/main/03-support-refund-desk), and all 7 projects in [`agbossjs/agboss-examples`](https://github.com/agbossjs/agboss-examples) — see [Example](Example#standalone-verified-applications-agbossjsagboss-examples).
