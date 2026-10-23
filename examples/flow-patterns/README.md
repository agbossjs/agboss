# flow-patterns

The zero-cost harness of AGBoss's public surface (#419): the flow's patterns as one application
(`src/flow-patterns.application.ts`), one `*.workflow.ts` each, on the public entries only — and
the help desk also as an offline application of its own (`src/desk.application.ts`), whose only
model provider is a transport that answers by the request, so it runs with no key and no network,
and which serves the desk over A2A to the helpline of the first:

| Folder           | Pattern                                                                                                                                                                                                            | Start                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| `src/offer/`     | a review loop                                                                                                                                                                                                      | `offer-workflow-start`            |
| `src/credit/`    | a code router beside a model router                                                                                                                                                                                | `credit-workflow-start`           |
| `src/review/`    | parallel launches in waves (#273)                                                                                                                                                                                  | `review-workflow-start`           |
| `src/panel/`     | a quorum with a code and a model arbiter (#279)                                                                                                                                                                    | `panel-workflow-start`            |
| `src/vendor/`    | a child workflow per vendor (#263)                                                                                                                                                                                 | `vendor-screening-workflow-start` |
| `src/topic/`     | a workflow launching itself, `maxDepth: 3` (#264)                                                                                                                                                                  | `topic-research-workflow-start`   |
| `src/approvals/` | two approvals at once, in the terminal (#267)                                                                                                                                                                      | `offsite-booking-workflow-start`  |
| `src/hiring/`    | undoable steps: `compensateWith` / `committedBy` (#339)                                                                                                                                                            | `send-offer-workflow-start`       |
| `src/travel/`    | a failed join undoes its finished bookings (#340)                                                                                                                                                                  | `trip-workflow-start`             |
| `src/desk/`      | the extension points: a custom compaction, code guardrails, a tool interceptor, a transport model provider (#382–#385); a code judge, a knowledge base, a PII detector, an observer, a health check and a step cap | `desk-workflow-start`             |
| `src/helpline/`  | a consumer of the desk over A2A: an `@A2AAgent` contract, checked by `check --federation` (#398)                                                                                                                   | `helpline-workflow-start`         |

```bash
npm install && npm run build          # repo root
cd examples/flow-patterns
npm run describe                      # every workflow: its paths, inputs, models, infrastructure
npm run check                         # agboss check --strict on both applications: the desk against its
                                      # snapshot (snapshots/, a changed export needs a new version), the
                                      # helpline's contract against the desk's describe --json
                                      # (--federation, no network); --models on `test` (no key), then
                                      # eslint with agboss/eslint (eslint.config.js)
npm run snapshot                      # the desk's describe --json, after raising its expose's version
npm test                              # scripted models only: no key, no network
```

The tests never call a model. The desk runs for real offline — its model provider
(`src/model-providers/harness.model-provider.ts`) looks the `#<id>` order up, then quotes the tool:

```bash
npx agboss run --application src/desk.application.ts --env test --start desk-workflow-start \
  --input '{"customerId":"c-1","question":"Where is order #7?"}'
```

A real run uses the `dev` environment (`src/environments/`): models
through OpenRouter, and every store — budgets, records, pauses, checkpoints, leases — in SQLite at
`.agboss/flow-patterns.sqlite` (git-ignored), so a paused run waits across processes.

## Real runs

Once, in the repo root:

```bash
scripts/langfuse.sh up                # local Langfuse at http://localhost:3000; writes its keys to .env
```

Add the model key and the PII key to the same `.env` (repo root):

```bash
OPENROUTER_API_KEY=sk-or-...
PII_PSEUDONYM_KEY=any-long-random-text # the application's PII key: required by `dev`
# OPENROUTER_BASE_URL=...             # optional: a proxy or a local OpenAI-compatible server
```

Then, in every terminal you run from:

```bash
cd examples/flow-patterns
set -a && . ../../.env && set +a      # OPENROUTER_API_KEY, PII_PSEUDONYM_KEY, LANGFUSE_*
```

Langfuse traces a run only when its `LANGFUSE_*` keys are set; without them a run is not traced.
Log in to http://localhost:3000 with the user `scripts/langfuse.sh up` printed and open
**Tracing → Traces**: one trace per execution, the newest first. A run prints its thread and cost
on standard error; `--json` prints its output on standard output.

### #263 M1 — children in Langfuse (vendor screening)

```bash
npx agboss run --start vendor-screening-workflow-start \
  --input '{"text":"check these vendors: Acme, Globex, a vendor that does not exist"}'
```

Look at the trace of `vendor-screening-workflow`:

- under the launch step, one nested `vendor-check-workflow` node per vendor, each with its own
  `executionId` and `itemIndex` (0, 1, 2) in its metadata;
- each child ends at `vendor-scored-workflow-finish`, `vendor-rejected-workflow-finish`, or — when
  its check fails — `vendor-check-failed-workflow-finish`; `vendor-ranker-agent` gets one result
  per vendor.

Not OK: a child's steps flat in the parent's trace. Run a second turn with
`--thread <id from the first run>`: its agents must not see a child's messages.

### #264 M1 — topic research in Langfuse (recursion)

```bash
npm run describe                      # topic-research-workflow: recursive: ThisWorkflow, maxDepth 3,
                                      # and what is left on the last level
npx agboss run --start topic-research-workflow-start \
  --input '{"title":"the history of computing","level":0}'
```

Look at the trace of `topic-research-workflow`: children nested at most three levels deep
(`depth` 1–3); on level 3 `researcher-agent` only reports (never a `TopicTooBroadDto`); at no moment
more than 4 executions of the tree working at once (`maxConcurrentExecutions: 4` — compare the
start and end times of the working steps). Not OK: a fourth level, or a fifth execution working
beside four others.

### #267 M1 — two approvals at once

```bash
npx agboss run --start offsite-booking-workflow-start \
  --input '{"text":"Offsite: Lakeside Lodge for $1800, flights TLV to LIS for $2400"}'
```

Both buyers run side by side and each purchase waits for you: the terminal channel prints each
question **once**, with its pause's id —

```text
[APPROVAL REQUIRED] Lakeside Lodge for $1800 (pause 1fc27165…)
[APPROVAL REQUIRED] flights TLV → LIS for $2400 (pause 7b76c926…)
```

— then `agboss run` asks about the first: `venue-buyer-agent wants to call place-purchase-tool … —
approve? [y/N]`. Leave that question open, and in a **second terminal** (same `cd` and `set -a`
line) answer both pauses at once:

```bash
npm run answer -- <first pause id> <second pause id>   # --decline to refuse both
```

Expect two lines `taken — finished at offsite-booking-workflow-finish: {"summary":"venue Lakeside
Lodge: booked; flights TLV → LIS: booked"}`: both answers taken, the run went on, no question
printed again. Now press the same answer again — in the first terminal answer `y`
(`agboss run: pause … is not waiting for an answer`), or `npm run answer -- <first pause id>` in
the second (`NotPausedError — pause … is not waiting for an answer`). In Langfuse each buyer's
`place-purchase-tool` ran once.

Answering in the first terminal only (`y`, then `y`) takes the two answers one after the other.
The pauses also outlive the process: stop the first terminal with Ctrl+C while it asks, then
`npm run answer -- <both ids>` continues the run from SQLite.

Not OK: a question printed twice, an answer lost (the run never finishes), or a tool or agent step
run twice.
