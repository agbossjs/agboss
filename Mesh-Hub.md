# Mesh Hub — `agboss hub`

A company runs many AGBoss applications, and they call each other over A2A and MCP. The Mesh Hub
puts them in one picture: which applications there are, what each one is made of, who calls whom,
and how each one is doing — **read from files the applications already write**, never from a live
service. It needs no project, assembles no application and reaches no network (#401).

```bash
# each service's CI saves what it has
agboss describe --json > hub/desk-application/describe.json
agboss eval run --suite refunds-eval-suite --runs 5 --env eval --report hub/desk-application/refunds.run.json
agboss records export --env prod --tenant acme --since 2026-10-16 --out hub/desk-application/records/acme.jsonl

# a platform repo reads the folder: one static page
agboss hub show hub/ --html .artifacts/mesh.html
```

```text
hub: 6 applications · 41 workflows · 9 observed cross-service edges
snapshots 6 · eval runs 11 · kept executions 7812
report → .artifacts/mesh.html (3.4 MB, self-contained)
```

## Inputs: files that say what they are

`agboss hub show <path…>` takes files and folders. A folder is read whole — its `*.json` and
`*.jsonl` files, any depth, in name order; a file is read as given, whatever its name. There is no
manifest and no folder convention: **each file says what it is by its own marker**.

| Kind | Marker | Written by |
| --- | --- | --- |
| an application's snapshot | `{ "schema": 1, "ok": true, "command": "describe", … }` | `agboss describe --json` |
| an eval run | `{ "kind": "agboss.eval-run", "schemaVersion": …, … }` | `agboss eval run --report` ([Eval suites](Eval-Suites)) |
| kept executions | JSON Lines, every line `{ "kind": "agboss.execution-record", "schema": 1, … }` | `agboss records export` ([Execution history](Execution-history)) |

A file of any other kind, or a schema newer than this agboss reads, is `hub.input-schema` (exit 3)
naming the file — and for an export, the line and the field (`bad.jsonl: line 2.executionId is not
a string`). Two snapshots of one application **version** are `hub.duplicate-application` (keep one
per version; two versions of one application are fine — the newest describes it). A path that does
not exist is `hub.input-not-found`, no path at all exit 2.

## The page

`--html <file>` writes one self-contained page in the eval report's shell: its style and its one
script inline and allowed by their hashes in its Content-Security-Policy, no request of any kind —
it opens from `file://` and is shared as a file, behind the company's own SSO (an internal Pages
site, a bucket behind IAP). The Hub has no login of its own.

- **The agent mesh** — every application as a box, in name order on an ellipse (the same files
  draw the same picture), each a link to its card. A solid box is an application a snapshot
  describes; a dashed one is only named by records, eval runs or a call. An arrow is an observed
  edge, labelled with its calls.
- **Observed edges** — the calls between applications the records saw: a caller's tool call that ran
  a remote AGBoss execution (`toolCalls[].remote`) and a receiver's own record of who called it
  (`origin`). When both applications exported their records one call is seen twice — the calling
  step's `idempotencyKey` is the same on both sides, so it is **counted once**. Applications are
  matched by name, never by tenant (a tenant id does not cross organisations). Each edge lists its
  calling workflows and tools.
- **A card per application** — its versions and snapshot; each workflow of its newest snapshot with
  its agents, routers, actions, child workflows, tools and MCP servers; its channel roles; and its
  health.

## Health: what the files say

Health is derived from the application's own files only — a static page cannot poll, and the Hub
reaches no URL. Live probes stay the orchestrator's job ([App](App), `app.checkReadiness()`).

- From its kept executions: how many (and paused), the failure rate of the ended ones, the 95th
  percentile of their durations, the spend and the spend per UTC day, and the `limit.*` / `mesh.*`
  codes they failed with (their own or a cause's — a budget, the steps limit, a mesh loop).
- From its eval runs: the latest run of each suite — pass^k and pass@k over its cases, the unstable
  cases, how many runs each case had.

## `--json` and the size bound

Without `--html` the command prints its summary. Under `--json`: `result = { applications: [{ name,
version, file }], inputs: { describe, evalRuns, records, files: [{ file, kind, count }] }, edges: {
observed: [{ from, to, calls, workflows, tools }] }, report?, bytes? }`, `created: [<html>]`. A page
above 16 MB is refused, `hub.report-too-large` (exit 2): export a shorter period.
