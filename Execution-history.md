# Execution history

What an application keeps of its root executions after they end, and how it is exported (#401
PR 1). Nothing is kept unless the application says how long; then each root execution's record is
kept in the `ExecutionHistoryRepository` — masked like its traces — and the recovery sweep removes it
once it ended longer ago than that. `agboss records export` writes it as JSON Lines.

## Keeping it: `executionRecordRetention`

<!-- snippet-context
import { Application, Injectable, SqliteExecutionHistoryRepository, SqliteExecutionRecordRepository } from "agboss";
import { hours } from "agboss/units";
@Injectable()
export class DeskWorkflow {}
export class AppEnvironment {
  sqlitePath!: string;
}
-->

```ts
@Application({
  name: "desk-application",
  version: "1.0.0",
  environment: AppEnvironment, // its sqlitePath: the file of the SQLite stores
  workflows: [DeskWorkflow],
  providers: [SqliteExecutionRecordRepository, SqliteExecutionHistoryRepository],
  executionRecordRetention: hours(24 * 30), // unset → nothing is kept (the default)
})
export class DeskApplication {}
```

- **Unset → nothing is kept**: no store is written, behaviour is as before. Set, every **root**
  execution of the application is saved — its children are inside it (`children`).
- **When**: each time its tree rests at a pause (`ExecutionHistoryStatus.Paused`, no `endedAt`) and
  once it ends — `Finished`, `Failed` or `Cancelled` (an `app.cancel`, a cancel request), the last two
  with the `error` that ended it. A save replaces the record of its tenant and execution. Work handed
  over (a lost lease, the app's stop) saves nothing — the instance that continues the tree does.
- **Built from the checkpoint**: any instance can save it — the start time (`startedAt`, the
  `Clock` at the root's start) and the contexts are in the tree's state. A save that fails is a
  warning in the log (`execution-history.failed`), never the execution's failure.
- **Removed** by the recovery sweep (every 30 s, on the `Clock`) once it ended longer ago than
  `executionRecordRetention`; a record still paused is never removed.
- On the built-in in-memory store it warns **`[application.in-memory-execution-history]`** — each
  instance keeps its own, another instance and `agboss records export` do not see them, a restart
  loses them (an error under `agboss check --strict`). `SqliteExecutionHistoryRepository` keeps it in
  the application's SQLite file (table `execution_history`); a store of your own `extends
  ExecutionHistoryRepository` ([Several instances → Your own implementation](Several-instances#your-own-implementation)).

## What a record holds: `ExecutionHistoryRecord`

The execution's `ExecutionRecord` — what `app.execute(…, { record: true })` returns — with who and
what it was:

| Field | What it is |
| --- | --- |
| `executionId`, `rootExecutionId`, `parentExecutionId?` | its id; its tree's root (its own: only roots are kept); a root has no parent (a mesh caller is its `origin`) |
| `threadId`, `tenantId` | its thread and tenant |
| `application` | `ApplicationRecord`: `name`, `version`, `instanceId` of the instance that saved it |
| `workflow` | `WorkflowRecord`: `name`, `version`, `startedVersion`, `configHash` |
| `status` | `ExecutionHistoryStatus`: `paused`, `finished`, `failed`, `cancelled` |
| `startedAt`, `endedAt?` | ISO 8601 on the application's `Clock`; `endedAt` once it ended |
| `start`, `input` | its start (`ComponentRecord`) and the start's input |
| `finish?`, `output?` | its finish and output, when it finished |
| `contexts` | `ExecutionContextRecord`: its `tenant` and `execution` values |
| `error?` | the `ErrorRecord` that failed or cancelled it |
| `path`, `scope`, `outdatedValues`, `lastError?`, `spend`, `children`, `pauses`, `compensations`, `toolCalls`, `steps`, `origin?` | its `ExecutionRecord` ([App → The result](App#the-result--executionoutput)): who answered each pause, its tool calls and step records (#395), where a trusted mesh request came from (#398) |

**Masked like its traces**: every string through the application's and the workflow's PII policies
(`<email>`, `<email:7f3a91>`), a context field marked `sensitive` hidden — a record never holds what a
trace would not show ([Guards → PII](Guards)).

## The store: `ExecutionHistoryRepository`

Infrastructure ([App → Infrastructure](App#infrastructure)), listed only in
`@Application({ providers })`, Spring Data names:

| Method | What it does |
| --- | --- |
| `ping()` | one fast round trip (#300 readiness) |
| `save(record)` | saves a record, replacing the one of its tenant and execution |
| `findByTenantIdAndExecutionId(tenantId, executionId)` | one tenant's record of an execution |
| `findAllByExecutionId(executionId)` | the records of an id, whatever the tenant (an operator's lookup) |
| `findAllByTenantIdAndThreadId(tenantId, threadId)` | a thread's records, oldest start first |
| `findAllByTenantIdAndStartedAtBetween(tenantId, from, to, page)` | one tenant's records started in `[from, to)`, oldest first, `{ offset, limit }` |
| `findAllByStartedAtBetween(from, to, page)` | every tenant's, the same way |
| `deleteByEndedAtBefore(cutoff)` | the sweep: removes what ended before `cutoff` |

## Exporting it: `agboss records export`

```bash
agboss records export --env prod --tenant acme --since 2026-10-16 --out hub/records/acme.jsonl
agboss records export --env prod --all-tenants --out hub/records/all.jsonl
```

```text
records: 1284 executions (acme) → hub/records/acme.jsonl
```

- Opens the application's stores in the `--env` environment **without running anything**: no
  workflow built, no recovery sweep, no execution moved.
- One record per line, oldest start first, each self-describing:
  `{ "kind": "agboss.execution-record", "schema": 1, …record }`. The records are written as they were
  kept — masked.
- A tenant is always named (`--tenant <id>`) or every tenant explicitly (`--all-tenants`): neither or
  both is `records.tenant-required` (exit 2). `--since` / `--until` take an ISO 8601 date or time —
  records started in `[since, until)` — another value is `usage.option-value` (exit 2). An application
  without `executionRecordRetention` is `records.not-kept` (exit 3).
- `--json`: `result = { records, tenantId, file }`, `created: [<file>]`.

## Into an eval case: `agboss generate eval-case`

A kept execution becomes a case of an eval suite with `agboss generate eval-case <name>
--from-execution <executionId>` — its turn, contexts, earlier turns and the calls it ran, masked as
kept ([Eval suites](Eval-Suites#a-case-from-a-kept-execution-agboss-generate-eval-case)).
