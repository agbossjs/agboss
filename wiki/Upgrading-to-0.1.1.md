# Upgrading to 0.1.1 — A2A is the real protocol

0.1.1 has one breaking change in A2A: `@A2AExpose` / `a2aHttpListener` serve **A2A v1.0**
([the specification](https://a2a-protocol.org/v1.0.0/specification/)) and `@A2AAgent` / `A2AClient`
call any v1.0 agent. The 0.1.0 wire is gone, with **no shim**: its `POST <url>/execute`, `/resume`
and `/cancel`, its `agboss-mesh` header and its `A2AExecutionResponse`. A 0.1.1 client and a 0.1.0
server do not interoperate — upgrade both sides of an A2A call together. MCP is unchanged. A v0.3
agent is an explicit `A2AProtocolError` naming its version.

Pauses change too: `withdraw` on a channel is gone — [`onPauseClosed`](#pauses--withdraw-is-gone-a-channel-hears-every-close)
replaces it — and `answeredBy` on a channel role is `answerer`.

What you get: an Agent Card at `<base>/.well-known/agent-card.json`, JSON-RPC (`SendMessage`,
`SendStreamingMessage`, `GetTask`, `ListTasks`, `CancelTask`, `SubscribeToTask`), durable tasks that
outlive their connection, one execution per `messageId`, direct `Message` replies, file parts, and
the AGBoss guarantees as two extensions
([mesh](A2A-Mesh-Extension), [skills](A2A-Skills-Extension)) — see [A2A](A2A).

## Migration

| 0.1.0 | 0.1.1 |
| --- | --- |
| `@A2AAgent({ target: { application, start } })` | `target: { application, skill }` — the skill id is the exported start's name, so the value stays; `target` itself is optional (a foreign agent has none) |
| `client.cancel(threadId)` | `client.cancel(taskId)` — cancels that task only; `call.threadId` is `call.contextId` |
| `A2ARoute` (`Execute`, `Resume`, `Cancel`), `request.route` | `A2AOperation`, `request.operation`; a resume is `SendMessage` with a `taskId` |
| `a2aHttpListener(app, { expose, callerResolver })` | adds `publicUrl`: where callers reach it, the card's interface URL |
| `@A2AExpose({ name, version, exports })` | adds a `description` (`[a2a.expose-description-required]`) and, for a card worth finding, `skills: { [start]: { tags } }` (`[a2a.skill-tags]`, a warning) |
| `A2AExecutionResponse`, `A2AStatus`, `A2AEvent`, `A2AExecutionRequest` | removed; a call returns the remote output (`execute`) or an `A2ATaskResult` (`send`) |
| `A2ARemoteError`, `A2AContract` | `A2ARemoteCallError`, `A2AClientContract`; the adapter types are gone |
| the mesh envelope in the `agboss-mesh` header | `message.metadata["https://agboss.dev/a2a/mesh/v1"].envelope` |
| a run report in the response body | `task.metadata[uri].report` |
| `describe --json` exports and imports by `start` | by `skill`; a foreign `@A2AAgent` is listed with `foreign: true` — re-save your federation snapshots (a 0.1.0 snapshot is still read) |
| — | `@Application({ retention: { a2aTasks, a2aMessages, a2aFiles } })`: how long a finished task (and a resent `messageId`'s answer), a direct reply and a task's files are kept — defaults 24 h, 15 min, `a2aTasks` |
| — | an application serving A2A on shared leases lists a task store they share (`[a2a.task-store-not-shared]`) |

A disconnect no longer cancels a run: the task goes on, and `GetTask` / `SubscribeToTask` read it.
A client resends an ambiguous accept only to an AGBoss peer, within the retention its card declares
— never to a foreign peer.

## Pauses — `withdraw` is gone, a channel hears every close

0.1.1 adds a deadline to a pause, notices to channels and listeners, and one meaning per name. Two
things in your code change.

**`withdraw` is gone → `onPauseClosed`.** `ChannelHandler.withdraw`, `ChannelOf.withdraw` and
`ChannelWithdrawal` (#337) are removed. A channel is told, **at least once**, whenever a pause it sent
closes — withdrawn, cancelled, expired, answered (also elsewhere), its tree ended — through
`onPauseClosed(event)`. Nothing else changes in the channel: `send` is the same.

```ts
import {
  Channel,
  ChannelOf,
  ChannelOutcome,
  ChannelRole,
  PauseAnswerer,
  PauseClosedReason,
  type ChannelAsk,
  type ChannelPauseClosedEvent,
} from "@agboss/core";
import { Flag, Text } from "@agboss/core/dto";

export class HoldRequest {
  @Text() bookingId!: string;
}

export class HoldDecision {
  @Flag({ prompt: "whether the hold goes on" }) approved!: boolean;
}

@ChannelRole({
  name: "hold-question",
  description: "Approves a hold",
  ask: HoldRequest,
  answer: HoldDecision,
  answerer: PauseAnswerer.Channel,
})
export abstract class HoldQuestion extends ChannelOf<HoldQuestion> {}

@Channel({ name: "mail-hold-channel", description: "Asks by mail" })
export class MailHoldChannel extends HoldQuestion {
  send(_ask: ChannelAsk<HoldQuestion>): Promise<ChannelOutcome<HoldQuestion>> {
    return Promise.resolve(ChannelOutcome.awaitReply());
  }

  // 0.1.0: override withdraw(withdrawal) — called once, only when a pause was taken back
  // 0.1.1: called for every close; event.reason says which, event.deliveryId is the dedupe key
  override onPauseClosed(event: ChannelPauseClosedEvent<HoldQuestion>): Promise<void> {
    if (event.reason === PauseClosedReason.Answered) return Promise.resolve(); // marked by whoever answered
    console.log(`take back the question ${event.pauseId}: ${event.reason}`);
    return Promise.resolve();
  }
}
```

| 0.1.0 | 0.1.1 |
| --- | --- |
| `override withdraw(w)` | `override onPauseClosed(event)` |
| `w.resolution` (`PauseResolution`) | `event.reason` (`PauseClosedReason`: `Answered`, `Expired`, `Cancelled`, `Withdrawn`, `TreeEnded`) |
| called once, never after a crash | at least once: **deduplicate by `event.deliveryId`**, and make the hook safe to run twice |
| the warning `channel.withdraw-failed` | `pause.notice-failed` (each failed attempt), `pause.notice-dead` (set aside after `retention.pauseRecords`) |
| — | `@PauseListener` for a hook on every pause of the application; `PauseExpiration`, `remindBefore`, `app.extendPause` — [Pauses](Pauses) |

**`answeredBy` on a role → `answerer`.** `@ChannelRole({ answeredBy: PauseAnswerer.Channel })` becomes
`answerer: PauseAnswerer.Channel` (#934): `answerer` is who *may* answer, `answeredBy` is who *did*. The
old spelling is accepted, `@deprecated`, until 0.2. One change has no alias and does not fail to compile:
`PauseAnswerRecord.answeredBy` (`result.record.pauses`) used to hold the kind (`"channel"`,
`"thread-owner"`) and now holds the person (`"manager-17"`) — an audit filter on the old meaning now
matches nobody; filter on `answerer`. The list of every renamed field is in the
[Changelog](Changelog).

Your own `PausedExecutionRepository` or a store of another team: pauses have a deadline, a reminder and
mailboxes of notices now, in the same transactions as their changes — a schema change in each of the
three stores ([below](#the-stores--what-to-run)) and new cases in the contract suite
([Your own store](Your-own-store)).

## The stores — what to run

A durable store has its own upgrade step. The order is the same for each, and it is **not a rolling
upgrade** ([ADR-0034](ADR-0034-Schema-upgrades-stop-the-old-version-first)):

1. **Stop every instance of the old version** — scale to zero and let the pods drain, or stop the
   processes. A pod that stays up writes in the old shape into the database you are about to
   migrate: a pause without its channel, a lease under a column that is renamed, no notice for a
   pause it closes, a side effect that commits after a cancel (the fence of [#909](Several-instances#cancelling-from-any-instance)
   holds only when no instance of the old version runs).
2. **Run the migration** (`agboss-postgres migrate`, `agboss-mongodb migrate`; SQLite migrates when the
   first new process opens the file).
3. **Start the new version.**

This holds for every 0.1.x upgrade that changes a store schema, and 0.1.1 does for all three
stores. A Helm `pre-upgrade` hook or an Argo CD `PreSync` Job runs the migration **while the old pods
still serve**: use it only for an upgrade that changes no schema (`migrate` then prints `nothing to
apply`), see [Deploying on Kubernetes](Deploying-on-Kubernetes#upgrading-across-a-schema-change).
`@agboss/postgres` and `@agboss/mongodb` are first published with 0.1.1, so the steps
below are for a database an earlier build of the package wrote; SQLite is the core's own, written by
0.1.0.

| Store | What to run | What you see if you skip it |
| --- | --- | --- |
| PostgreSQL | `npx agboss-postgres migrate` **after the old pods are stopped** and before the new ones start. It applies the numbered migrations, then builds the index `checkpoints_latest_by_step` (`CREATE INDEX CONCURRENTLY`: checkpoint writes keep flowing while it builds). Its last line says `built index …`, `index … is ready` or `skipped index …` (another run holds the build's lock: run it again when that one ends). | A start refuses an unmigrated schema (`PostgresSchemaMissingError`, naming the command). A start with `postgresSchemaSetup: SchemaSetup.MigrateOnStart` waits for live leases to lapse (`PostgresLiveLeasesError` while one is live), then migrates and builds the index in the background. Without the index everything is correct, a marked thread's latest read only lists and sorts its namespace (38 ms on 10 000 checkpoints, instead of 1.7 ms). |
| MongoDB | `npx agboss-mongodb migrate` is **mandatory before the 0.1.1 pods start**, and runs **after the old pods are stopped**: once the database is migrated, an old pod that restarts is refused (`MongoSchemaTooNewError`), but an old pod that is still running is not stopped by it. It applies the schema versions up to the build's (`checkpoint_latest_by_step`, version 2, the checkpoints' index `latest_by_step`; `pause-deadlines-and-notices`, version 3, the pause channels) and rewrites no checkpoint. | A 0.1.1 pod on a database at version 1 does not start (`MongoSchemaMissingError`, naming the command). Checkpoints written before get their `step` when their thread is first read: about 100 ms for a thread of 2 000 checkpoints, once per thread. |
| SQLite | Nothing to run, but stop every 0.1.0 process on the file first: it is migrated when the first 0.1.1 process opens it — a generated column `step` on the metadata and an index on it, no row rewritten (57 ms for 20 000 checkpoints), a column for each tree's cancel mark on the leases (#1117), and the file is stamped with its schema version (table `agboss_schema`). A file with no stamp is a 0.1.0 file and is migrated. | Nothing to skip. A 0.1.0 process that is still running is **not refused** (0.1.0 never reads the stamp): it writes pauses with no channel, and takes no part in the cancel fence. |

- **SQLite and an older version**: the column is generated, so 0.1.0's own `INSERT` of a checkpoint
  still works on a file 0.1.1 opened, and 0.1.1 reads what 0.1.0 wrote in order (#1035). A second
  process still on 0.1.0, or a rollback to it, does not break checkpoint writes — but it is not
  supported: the file is stamped, and **a later build** that finds a stamp above its own refuses the
  file at open (`SqliteSchemaTooNewError`, code `sqlite.schema-too-new`, before it creates a table
  or writes a row), as `PostgresSchemaTooNewError` and `MongoSchemaTooNewError` do. 0.1.0 is already
  released and cannot be taught that: stopping it is the rule (#1104). A pause that a 0.1.0 process
  writes without its `channel` is found by a page filtered by channel all the same, and the column is
  filled at the next open. A build before the
  release that already made a stored `step` column has it replaced by the generated one on the next
  open.
- **A store of your own** is not required to change: `latestByStep` is optional, and a store
  without it keeps the scan, correct and slower ([Your own store](Your-own-store#the-checkpoint-savers-optional-latestbystep-962)).
- What the PostgreSQL index and the MongoDB versions are, in full: [Running on PostgreSQL](Running-on-PostgreSQL#the-checkpoint-index-962),
  [MongoDB](MongoDB#the-schema-and-its-versions).

The full list of changes of the release is in the [Changelog](Changelog).
