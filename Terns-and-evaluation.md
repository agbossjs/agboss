# Terns and evaluation

**Tern** — one question → answer round, i.e. one run. A **thread** is a client's sequence of Terns.

## Threads and history

- `app.execute(Start, input)` without `thread` = **first contact**: a new thread is created, its id
  comes back in the result (`thread`). The client sends it with every next question.
- `app.execute(Start, input, { threadId })` with an id the tenant does not have → `UnknownThreadError` before any call.
- Each model router and agent sees the last **`uncompactedTurns`** turns of the thread in full
  (finished executions only, oldest first), before its input message — see
  [Memory Management](Memory-Management).
- CLI: `agboss run --start <name> --thread <id> "…"`; every run prints `thread: <id>`.

```
Previous turns:
Q: My name is Pavel
A: Nice to meet you, Pavel.

Task:
What is my name?
```

## Conversation memory (compaction)

A `@Compaction` (#120 PR 3) summarises the turns older than the smallest window among the agents
and routers that use it — `CompactionStrategy.SummaryQueue` (self-contained summaries in a FIFO
queue of `summaryQueueLength`, each reading its turns plus the raw turns just before them as
context: nothing is re-compacted or blurred), `SingleSummary` (one summary rewritten every time) or
`None`. Older summaries leave the context but stay in the database (`summaries` table, by
compaction). Under the answer: `memory: conversation-compaction turns 1–5 → summary 1/10`. A summary
that does not fit `summaryMaxTokens` after one "shorter" retry fails the execution with
`CompactionError`. Details: [Memory Management](Memory-Management); the queue's origin:
[ADR-0007](ADR-0007-Conversation-memory-as-a-FIFO-queue-of-summaries).

## What a Tern stores

task · answer · status (`answered` | `guarded` | `failed` | `paused`) · stop reason · route · steps
(what each agent answered) · cost · `prompt_version` · `model_version` · `replay_of`.

- Every run writes a Tern — answered or failed.
- `prompt_version` / `model_version` = short sha256 of all agent and router prompts / of the resolved
  model settings. Same config → same versions; change a prompt → a new `prompt_version`.
- Storage: the application's `ExecutionRecordRepository` (#261) — listed in
  `@Application({ providers })`, else the built-in one: an in-memory database of the instance
  (built-in `node:sqlite`, `:memory:`), gone on restart; nothing is written to the home folder any
  more, so `agboss eval` / `replay` see the records of their own process only until the SQLite
  repository (#265) is listed. Schema migrations are versioned with `PRAGMA user_version`.
- Module `src/terns` depends on nothing else in `src` (ESLint).

## Scoring quality

```bash
npm run eval   -- [--version <prompt_version>] [--limit 100]
```

A judge (the default router model — Jev) answers for every unscored answered Tern: _is the answer
adequate to the task?_ Score = P(adequate). The command prints what was scored and a summary per
prompt version: Terns, scored, mean score, cost. A judge failure leaves a Tern unscored.

## Comparing a prompt change

```bash
npm run replay -- --version <old prompt_version> [--limit 100]
```

Re-runs the stored tasks of the old version with the **current** config as new threads
(`replay_of` set), scores both sides and prints `before → after` on the same tasks.

## Budget

Eval and replay run within the application's budgets (#261): a replayed execution is checked and
counted like any (an exhausted tenant or application budget stops the replay), and the judge's calls
count in the application budgets, scoring stopping once one is exhausted by its last known limit
([FinOps](FinOps#eval-spend)). Both stop cleanly.

## Calibrate the judge first

Before trusting mean scores, label 20–30 Terns by hand and check the judge agrees with you.

## Comparing configurations

Every Tern also stores the declared config `version` and a config hash. To compare variants on the
same tasks (profiles, golden sets, pairwise judge), see [Profiles and comparisons](Profiles-and-comparisons).

### How versions are hashed

`promptVersion`, `modelVersion` and `configHash` are SHA-256 hashes of **canonical JSON
(RFC 8785)**: object keys in UTF-16 code-unit order (never the machine's locale), ECMAScript number
form, undefined object properties left out — the same configuration gets the same version on every
machine. A value that is not JSON (`NaN`, `Infinity`, `Map`, `Set`, `Date`, class instances,
`bigint`, functions, `undefined` inside an array, lone surrogates, cycles) throws `NonJsonValueError`
naming its path (`$.a[2]`).

### What the config hash covers (#120 PR 4)

`configHash` (the workflow's fingerprint, the one key: #268 S93) hashes the config, the flow, every
text a model is sent as it is sent (normalised at load, [Components](Components#file-conventions)),
and two sub-trees for what changes a model's input but lives outside its element's decorator:

- `elements` — per agent and model router: the PII policies in effect at its model (application +
  workflow + own − excluded, [Guards](Guards#levels-1)) with their rules and actions (a
  `replacePart({ pattern })` by its text) or a project detector's action; its `uncompactedTurns` and
  the compaction in effect ([Memory Management](Memory-Management)); an agent's judges (name and
  model). Excluding a policy on one agent, another compaction or window, or another judge each give
  another hash.
- `frame` — the framework's own texts its models read: the routers' instructions, the agent loop's
  (the answer-tool instructions, the history and decisions framing, a judge's retry message, a
  rejected call), the knowledge bases' framing; a launch router's, a compaction's, an arbiter's and
  a guardrail's only in a workflow that has one.
- `children` (#336) — only in a workflow that launches child workflows: every child reachable from
  its flow, recursively, each once by name with its own snapshot (`ThisWorkflow` is never one: a
  recursive workflow is hashed once). A child's change — a prompt, a model, its flow, its version —
  is a change of every workflow above it, so a paused or running root whose child changed is
  incompatible ([Several instances → Recovery](Several-instances#recovery)).

`agboss describe` prints the same hash as a run of that configuration records. Quality metrics stay
out of it (#123).

The full 64 hex characters are stored; people see the first 8 (`agboss describe`, the drift warning).
Hashes recorded before #134 have 12 characters and are not comparable with new ones — the length
marks the boundary; old Terns are not migrated, and a 12-character config hash is not reported as
drift.
