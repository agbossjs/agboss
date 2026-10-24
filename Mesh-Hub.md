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
  describes; a dashed one is only named by records, eval runs, a call or a contract it produces. An
  arrow is an observed edge, labelled with its calls; a dashed arrow a declared contract no record
  shows (`declared`); a red one a contract `check --federation` finds broken (`incompatible`).
- **Observed edges** — the calls between applications the records saw: a caller's tool call that ran
  a remote AGBoss execution (`toolCalls[].remote`) and a receiver's own record of who called it
  (`origin`). When both applications exported their records one call is seen twice — the calling
  step's `idempotencyKey` is the same on both sides, so it is **counted once**. Applications are
  matched by name, never by tenant (a tenant id does not cross organisations). Each edge lists its
  calling workflows and tools.
- **A card per application** — its versions and snapshot; each workflow of its newest snapshot with
  its agents, routers, actions, child workflows, tools and MCP servers; its channel roles; and its
  health.

## Blast radius & federation

Every contract a snapshot declares — `application.contracts.imports` of `describe --json`: an
`@A2AAgent`'s target start, an `@McpServer` tool's target expose ([A2A](A2A)) — is a **declared
edge**, consumer → producer, with the consumer's workflows and tools that use it. A producer no
snapshot describes is drawn as a dashed box and its contract marked "producer not among the
inputs"; a third-party MCP server (no target application) is no edge at all.

The problems are **`agboss check --federation`'s own**: the Hub calls the same function,
`checkFederation`, over the newest snapshot of every application — so it reports what the check
reports, `[federation.incompatible-schema]` and `[federation.missing-target]` with the same
messages and the same **blast radius** (the consumer's application, workflows and tools the
contract feeds) — and marks each broken contract on its edge and its row. The Hub only reads; the
gate stays the check in CI ([A2A → The federation check](A2A#8-the-federation-check-398-pr-4)). A
snapshot from an agboss that wrote no `contracts` is named ("no declared contracts read from"),
never guessed.

Beside them: each application whose **latest eval run lost pass^k** on a case, and who calls it —
by a declared contract and by the calls the records saw (`via: declared | observed`) — the callers
a regression in it reaches.

## Execution trees across applications

One request can run in several applications: the shop's agent asks billing over A2A, billing's
agent searches a knowledge service over MCP. Each application exports only its own records; the
page puts the request back together as **one tree**, by the rule the mesh envelope makes possible
([A2A](A2A), #398):

- a record with an `origin` is a child of the execution whose `executionId` is
  `origin.executionId` — a root's, or one of its in-process children's —
- under that execution's tool call whose step `idempotencyKey` is `origin.step.idempotencyKey`.

Never by tenant: a tenant id does not cross organisations. Each tree, from its root, shows every
execution with its application, workflow, status, duration and spend, the calls that ran a remote
execution with the execution each ran, and the in-process child executions that called out.

- A call whose receiver **did not export** its record is a stub — `billing-application · b1 (not
  exported)` — not an error: the tree still reads.
- A receiver whose caller exported nothing (or whose caller's record holds no such call) is a root of
  its own, "called by" its caller.
- Only trees that cross applications are listed. `--json` gives each one's `rootExecutionId`,
  `application`, `applications`, `executions` and `stubs`.

## Crystallization radar

A model step that spends money to give the same answer to the same question is code waiting to be
written. The radar finds them across the mesh — deterministically, from the records only:

- **What it ranks**: every model step — an agent or a router with model calls (a code router spends
  nothing and is not on it) — per application, workflow and step, over all its visits in the
  exports, a child execution's too.
- **Stability**: of its visits whose input was seen at least twice (the same `steps[].inputHash`),
  the share that gave the most frequent decision for their input. A step record's `decision`
  ([Observability](Observability)) is `route:<node>` for a router, `launch:<node>,…` for the routes
  it launched, `variant:<class>` for a `oneOf` answer, else `answer:<hash>` of its value. No input
  seen twice → no stability.
- **Score** = spend × stability.
- **A candidate** to turn into code — a `DecidedBy.Code` router, an `@Action` — has at least
  **50** calls, stability **≥ 0.95**, and, where its workflow has eval runs among the inputs, pass^k on
  every case of the latest run of each suite (a failing one keeps it off).

The table lists every model step, candidates first, then by score: its calls, spend, stability over
how many repeated inputs and calls, its workflow's pass^k (or "no eval"), the score, and the first
executions it ran in. `--json` gives the same as `radar`.

## Health: what the files say

Health is derived from the application's own files only — a static page cannot poll, and the Hub
reaches no URL. Live probes stay the orchestrator's job ([App](App), `app.checkReadiness()`).

- From its kept executions: how many (and paused), the failure rate of the ended ones, the 95th
  percentile of their durations, the spend and the spend per UTC day, and the `limit.*` / `mesh.*`
  codes they failed with (their own or a cause's — a budget, the steps limit, a mesh loop).
- From its eval runs: the latest run of each suite — pass^k and pass@k over its cases, the unstable
  cases, how many runs each case had.

## Served: `agboss hub ui`

```bash
agboss hub ui hub/ --port 4318
```

```text
hub ui: http://127.0.0.1:4318/?token=4be1…9a   (Ctrl+C to stop)
inputs: hub · 6 applications
```

The same files, served on your own machine — what a static file cannot do: read large record sets
a page at a time and search across every export. It runs on **`agboss eval ui`'s own server and
rules** ([Eval suites](Eval-Suites)): 127.0.0.1 only, a fresh token per start (every request names
it), the `Host` header checked against its own port (DNS rebinding), no CORS header ever, and
read-only — it answers GET and HEAD, nothing else (405). The paths are read before it listens (a bad
file is exit 3 at once) and again on every request, so a new export shows at the next reload; a file
that stops reading is a 422 naming its code.

| Route | What it answers |
| --- | --- |
| `GET /` | the page `hub show --html` writes, with a link to the search |
| `GET /records?q=&application=&workflow=&status=&from=&to=&offset=&limit=` | the kept executions of every export that match, oldest start first, a page at a time (50 by default, at most 500) — a GET form to itself |
| `GET /api/mesh` | `{ applications, edges, declaredEdges }` |
| `GET /api/applications/<name>` | one application of the mesh, or 404 |
| `GET /api/trees/<rootExecutionId>` | one tree across applications, or 404 |
| `GET /api/records?…` | the search as JSON: `{ total, offset, limit, records }` |
| `GET /api/radar` | the radar |
| `GET /api/blast-radius` | `{ declaredEdges, problems, undeclared, unstableReach }` |

`q` finds a text in an execution's, its root's or its thread's id, its workflow or its application;
`from` / `to` compare start times as ISO 8601 text. `--port 0` takes a free port; a port outside
0–65535 is exit 2. It is for one person; to share the Hub, publish the static page behind your
company's SSO.

## `--json` and the size bound

Without `--html` the command prints its summary. Under `--json`: `result = { applications: [{ name,
version, file }], inputs: { describe, evalRuns, records, files: [{ file, kind, count }] }, edges: {
observed: [{ from, to, calls, workflows, tools }], declared: [{ from, to, kind, contract, target,
usedBy, isDangling, problems }] }, trees: [{ rootExecutionId, application,
applications, executions, stubs }], radar: [{ application, workflow, component, kind, calls, spendUsd,
stability, repeatedInputs, repeatedCalls, passHatK, score, isCandidate, executions }], federation: {
problems: [{ code, producer, consumer, message, file, blastRadius, isWarning }], undeclared,
unstableReach: [{ application, suites, consumers: [{ application, workflows, tools, via }] }] },
report?,
bytes? }`, `created: [<html>]`. A page
above 16 MB is refused, `hub.report-too-large` (exit 2): export a shorter period.
