# Upgrading to 0.1.1 — A2A is the real protocol

0.1.1 has one breaking change in A2A: `@A2AExpose` / `a2aHttpListener` serve **A2A v1.0**
([the specification](https://a2a-protocol.org/v1.0.0/specification/)) and `@A2AAgent` / `A2AClient`
call any v1.0 agent. The 0.1.0 wire is gone, with **no shim**: its `POST <url>/execute`, `/resume`
and `/cancel`, its `agboss-mesh` header and its `A2AExecutionResponse`. A 0.1.1 client and a 0.1.0
server do not interoperate — upgrade both sides of an A2A call together. MCP is unchanged. A v0.3
agent is an explicit `A2AError.Protocol` naming its version.

Pauses change too: `withdraw` on a channel is gone — [`onPauseClosed`](#pauses--withdraw-is-gone-a-channel-hears-every-close)
replaces it — and `answeredBy` on a channel role is `answerer`.

What you get: an Agent Card at `<base>/.well-known/agent-card.json`, JSON-RPC (`SendMessage`,
`SendStreamingMessage`, `GetTask`, `ListTasks`, `CancelTask`, `SubscribeToTask`), durable tasks that
outlive their connection, one execution per `messageId`, direct `Message` replies, file parts, and
the AGBoss guarantees as two extensions
([mesh](A2A-Mesh-Extension), [skills](A2A-Skills-Extension)) — see [A2A](A2A).

## Migration

| 0.1.0                                                                  | 0.1.1                                                                                                                                                                                                            |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@A2AAgent({ target: { application, start } })`                        | `target: { application, skill }` — the skill id is the exported start's name, so the value stays; `target` itself is optional (a foreign agent has none)                                                         |
| `client.cancel(threadId)`                                              | `client.cancel(taskId)` — cancels that task only; `call.threadId` is `call.contextId`                                                                                                                            |
| `A2ARoute` (`Execute`, `Resume`, `Cancel`), `request.route`            | `A2AOperation`, `request.operation`; a resume is `SendMessage` with a `taskId`                                                                                                                                   |
| `a2aHttpListener(app, { endpoint, authenticator })`                      | adds `publicUrl`: where callers reach it, the card's interface URL                                                                                                                                               |
| `@A2AExpose({ name, version, exports })`                               | `@A2AEndpoint({ name, version, description, ttl, skills })`: a `description` (`[a2a.endpoint-description-required]`), a required `ttl`, and `skills: [{ start, tags }]` for a card worth finding (`[a2a.skill-tags]`, a warning) |
| `A2AExecutionResponse`, `A2AStatus`, `A2AEvent`, `A2AExecutionRequest` | removed; a call returns the remote output (`execute`) or an `A2ATaskResult` (`send`)                                                                                                                             |
| `A2ARemoteError`, `A2AContract`                                        | `A2AError.Remote`, `A2AClientContract`; the adapter types are gone                                                                                                                                            |
| the mesh envelope in the `agboss-mesh` header                          | `message.metadata["https://agboss.dev/a2a/mesh/v1"].envelope`                                                                                                                                                    |
| a run report in the response body                                      | `task.metadata[uri].report`                                                                                                                                                                                      |
| `describe --json` exports and imports by `start`                       | by `skill`; a foreign `@A2AAgent` is listed with `foreign: true` — re-save your federation snapshots (a 0.1.0 snapshot is still read)                                                                            |
| —                                                                      | `@A2AEndpoint({ ttl: { tasks, messages } })`: how long a finished task (and a resent `messageId`'s answer) and a direct reply are kept, per endpoint; files age by `@FilePolicy({ ttl })` |
| —                                                                      | an application serving A2A on shared leases lists a task store they share (`[a2a.task-store-not-shared]`)                                                                                                        |

A disconnect no longer cancels a run: the task goes on, and `GetTask` / `SubscribeToTask` read it.
A client resends an ambiguous accept only to an AGBoss peer, within the retention its card declares
— never to a foreign peer.

## PII rules — three verbs on the kind (#1301)

A declarative `@PiiPolicy` writes each rule on its kind or group; `pii(…)` and the `replace…` /
`blockWithRefusal` names are gone, with no alias. Tokens do not change: a token's label is still
the kind's id (`<email:7f3a91>`).

| 0.1.0                                                                                                                 | 0.1.1                                                                        |
| --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `pii(PiiKind.Email, PiiAction.replaceWithKind())`                                                                     | `PiiKind.Email.mask()`                                                       |
| `pii(PiiKind.CardNumber, PiiAction.replacePart({ keepLast: 4 }))`                                                     | `PiiKind.CardNumber.mask({ keepLast: 4 })`                                   |
| `pii(PiiKind.Phone, PiiAction.replaceWithToken())`                                                                    | `PiiKind.Phone.tokenize()`                                                   |
| `pii(PiiKind.UsSsn, PiiAction.blockWithRefusal({ refusal: "…" }))`                                                    | `PiiKind.UsSsn.block("…")`                                                   |
| `pii(PiiGroup.Contact, …)`                                                                                            | `PiiGroup.Contact.mask()` (and the other verbs)                              |
| `sensitive: PiiAction.replaceWithToken()`, `action: PiiAction.replaceWithKind()`                                      | `PiiAction.tokenize()`, `PiiAction.mask()`                                   |
| `PiiActionKind.ReplaceWithKind` / `ReplacePart` / `ReplaceWithToken` / `BlockWithRefusal`                             | `Mask` / `MaskPart` / `Tokenize` / `Block`                                   |
| `PiiRefusalOptions`, `ReplaceWithKindAction`, `ReplacePartAction`, `ReplaceWithTokenAction`, `BlockWithRefusalAction` | removed; `MaskAction`, `MaskPartAction`, `TokenizeAction`, `BlockAction`     |
| `refusal(kind)` reading `kind` as a string                                                                            | `kind.id` (a `PiiKind` is a descriptor; `PiiKind.fromId(id)` reads one back) |
| one kind in two rules of a policy                                                                                     | `[pii.duplicate-target]` at assembly: one rule per kind or group             |

## PII keys — a policy's `secret`, the storage's `piiSecret`, rotation (#1301)

Tokens need a key that is the same on every instance, so one that was made up by the instance is gone:
a `tokenize()` rule or action, or a `sensitive: PiiAction.tokenize()` field, with no key to make its
token fails the start with `[pii.secret-required]`, naming the policy or the `Dto.field`. A key
can be rotated without a value getting a second token in a thread that holds the first.

| 0.1.0                                                                          | 0.1.1                                                                                                                          |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `@PiiPolicy({ pseudonymKey: secret("…") })`                                    | `@PiiPolicy({ secret: secret("…") })`                                                                                          |
| `@PiiPolicy({ detectWithModel: "…" })`                                         | `@PiiPolicy({ model: "…", modelProvider? })`                                                                                   |
| `@Application({ piiKeyField })` and a key made up by the instance              | `@DatabaseStorage({ piiSecret: secret("…") })`; none, and a token to make: `[pii.secret-required]`                             |
| `[application.pii-instance-key]` (a warning)                                   | gone: nothing tokenizes by a key of the instance                                                                               |
| `WorkflowStartTextDto.author` was a token                                      | `mask()`: a placeholder, no key needed                                                                                         |
| a key change gave every value a new token                                      | `previousSecret` / `previousPiiSecret` (`secret.optional("…")`): a thread's token for a value is kept, old tokens still reveal |
| a `Logger` a component injected wrote what it was given                        | masked by the application's PII policies, as the framework's own log is                                                        |
| an image redactor's region with a target it was not asked for refused the file | painted and warned (`files.redactor-unknown-target`); a region that cannot be painted still refuses                            |

No storage supplies a key, `InMemoryDatabaseStorage` included: a public constant would let anyone forge
a token. `testWith` has a fixed test key (refused under `NODE_ENV=production`), so tests need no secret.

## PII tokens change once (#1269)

Every use of the PII key now has a key of its own, derived by HKDF-SHA256
([Guards → the PII key hierarchy](Guards#the-pii-key-hierarchy)). Tokens change with it: the same value
has another `<email:…>` token under 0.1.1 than under 0.1.0, with the same `PII_PSEUDONYM_KEY`. Nothing
to migrate in the stores — a paused execution's token map is read as it is, its 0.1.0 tokens still
revealed, and its loop's masked texts are masked again — but a log or trace search that joins 0.1.0
tokens with 0.1.1 ones finds no match across the upgrade. Redeploy every instance of an application
together, as for A2A: during a rolling upgrade one value has two tokens (both revealed).

## PII — a child workflow is masked by its chain (#1150)

A behaviour change from 0.1.0 (#120 AC11): a child workflow was masked by the application's and
its own `@Workflow({ piiPolicies })` only — never its parent's — so a value its parent masks reached
the child's models and traces as it is. In 0.1.1 a child is masked by the union of its chain: the
application's, the root's, every ancestor's and its own lists, at its models and in everything
observed of it ([Guards → Levels](Guards#levels)). What to check:

| 0.1.0                                                                                                                              | 0.1.1                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a child's agents and routers read the values its parent's `@Workflow` policies mask                                                | they read them masked; where one must see a value, `excludePiiPolicies: [ParentPolicy]` on that agent or router, or `@Workflow({ excludePiiPolicies })` on the child for all its models — observability stays masked |
| an ancestor's rule and the child's may differ for one kind                                                                         | `[pii.conflicting-rules]` at assembly, naming the way (`… (under root-workflow)`): make the lists agree                                                                                                              |
| an `excludePiiPolicies` naming an ancestor's policy                                                                                | allowed; one no way into the workflow inherits is still `[pii.exclude-not-inherited]`                                                                                                                                |
| a child's spans, events, records, outbound calls and pause notices by its own lists (an `AnyWorker` child's spans by the root's) | by its chain's, wherever it runs; the root's record parts by the root's only                                                                                                                                         |
| a queued `AnyWorker` child row                                                                                                   | carries `piiPolicies` (its chain's policy names); a row without them is not readable, so finish or drain children queued by 0.1.0 before the upgrade (ADR-0034)                                                      |

`agboss describe` shows each way's effective sets under `pii chains`; the start log says the same
(`app.pii-policies`). A child's own `configHash` does not change. **The `configHash` of a workflow
that launches another changes once** when the application or the workflow itself lists a PII
policy: its snapshot adds `handedDown`, the policies its children inherit, so an inherited policy's
change is a change of the root. A tree of such a root paused or running before the upgrade is
incompatible with it (`ExecutionError.IncompatibleResume`, `recovery.incompatible`) unless the root's
`onIncompatibleResume` says `ResumeDecision.Resume` — as for any change of what its models read: the child now
runs under its chain's policies, which it did not under 0.1.0. Finish or drain those trees before
the upgrade, or give the root an `onIncompatibleResume` policy. Workflows without children, and trees where
neither the application nor a launching workflow lists a policy, keep their hash.

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
  ChannelOutcome,
  ExternalTask,
  PauseClosedReason,
  PauseRespondent,
  type ChannelAsk,
  type ChannelPauseClosedEvent,
} from "@agboss/core";
import { Bool, Text } from "@agboss/core/dto";
import { hours } from "@agboss/core/units";

export class HoldRequest {
  @Text() bookingId!: string;
}

export class HoldDecision {
  @Bool({ prompt: "whether the hold goes on" }) approved!: boolean;
}

@ExternalTask({
  name: "hold-external-task",
  description: "Approves a hold",
  input: HoldRequest,
  output: HoldDecision,
  respondent: PauseRespondent.Delegate,
  timeout: hours(24),
})
export class HoldExternalTask {}

@Channel({
  name: "mail-hold-channel",
  description: "Asks by mail",
  target: HoldExternalTask,
  ttl: hours(1),
})
export class MailHoldChannel {
  send(_ask: ChannelAsk<HoldExternalTask>): Promise<ChannelOutcome<HoldExternalTask>> {
    return Promise.resolve(ChannelOutcome.awaitReply());
  }

  // 0.1.0: override withdraw(withdrawal) — called once, only when a pause was taken back
  // 0.1.1: called for every close; event.reason says which, event.deliveryId is the dedupe key
  onPauseClosed(event: ChannelPauseClosedEvent<HoldExternalTask>): Promise<void> {
    if (event.reason === PauseClosedReason.Answered) return Promise.resolve(); // marked by whoever answered
    console.log(`take back the question ${event.pauseId}: ${event.reason}`);
    return Promise.resolve();
  }
}
```

| 0.1.0                                 | 0.1.1                                                                                                                                  |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `override withdraw(w)`                | `override onPauseClosed(event)`                                                                                                        |
| `w.resolution` (`PauseResolution`)    | `event.reason` (`PauseClosedReason`: `Answered`, `Expired`, `Cancelled`, `Withdrawn`, `TreeEnded`)                                     |
| called once, never after a crash      | at least once: **deduplicate by `event.deliveryId`**, and make the hook safe to run twice                                              |
| the warning `channel.withdraw-failed` | `pause.notice-failed` (each failed attempt), `pause.notice-dead` (set aside after `retention.pauseRecords`)                            |
| —                                     | `@ChannelListener` for a hook on every pause of the application; `PauseExpiration`, `remindBefore`, `app.extendPause` — [Pauses](Pauses) |

**A pause target and its channel are two classes (#1307).** 0.1.0's `@ChannelRole` (an abstract class a
`@Channel` `extends`) is split: the **target** says what is asked and who may answer, the **channel** only
carries it to the people. It is a hard break — no alias, nothing to keep compiling:

| 0.1.0                                                            | 0.1.1                                                                                                    |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `@ChannelRole({ approves: Dto, answerer, … })`                   | `@ToolApproval({ name, description, respondent, timeout, … })` (named `…-tool-approval`)                |
| `@ChannelRole({ ask, answer, … })`, a question role              | `@ExternalTask({ input, output, respondent, timeout, … })` (named `…-external-task`)                    |
| `answerer: PauseAnswerer.Channel` / `.ThreadOwner`               | `respondent: PauseRespondent.Delegate` / `.Owner` (`answeredBy` is who _did_, `respondent` who _may_)   |
| `@Channel` that `extends` the role, in `providers`               | `@Channel({ target, ttl })` with no `extends`, in `@Application({ channels })`                          |
| `@Tool({ channel: Role, expiresIn })`                            | `@Tool({ approval: Target })`; the deadline is the target's `timeout`                                    |
| `.toExternalTask(Role, { expiresIn })`                           | `.toExternalTask(Task)`; a different deadline is a different target                                      |
| `expiresIn` on a role, `@Application({ workingCalendar })`       | `timeout`, `remindBefore` and `calendar` on the target; no application-wide calendar                     |
| `ChannelOf<Self>`, `ChannelQuestionOf`, `ChannelAnswerOf`        | `ChannelAsk<Target>`, `ChannelOutcome<Target>` (typed by the target)                                     |
| `@PauseListener`, `allowAnswering`                               | `@ChannelListener`, `includePauseIds`                                                                    |
| `@ReplyInterpreter`, `ReplyInterpretation`, `overrideArguments`  | `@ChannelInterpreter`, `ChannelInterpretation`, `overrideInput`                                          |
| `PauseAnswerRecord.role`; pause record `channel` = the role      | `target` (the target) and `channel?` (the transport, absent for an owner's pause nobody is asked about) |
| `app.listPauses({ role })`                                       | `app.listPauses({ target })`                                                                             |

A target with several channels names a `@ChannelSelector({ target })` that picks one when a pause is
made. An `Owner` target with no channel at all waits for `app.resume`. A stored pause, run or answer entry
written by 0.1.0 has no `target` and is refused (`StoreError.UnreadableRecord`), never read.

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

| Store      | What to run                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | What you see if you skip it                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL | `npx agboss-postgres migrate` **after the old pods are stopped** and before the new ones start. It applies the numbered migrations, then builds the index `checkpoints_latest_by_step` (`CREATE INDEX CONCURRENTLY`: checkpoint writes keep flowing while it builds). Its last line says `built index …`, `index … is ready` or `skipped index …` (another run holds the build's lock: run it again when that one ends).                                                                                       | A start refuses an unmigrated schema (`PostgresSchemaMissingError`, naming the command). A start with `postgresSchemaSetup: SchemaSetup.MigrateOnStart` waits for live leases to lapse (`PostgresLiveLeasesError` while one is live), then migrates and builds the index in the background. Without the index everything is correct, a marked thread's latest read only lists and sorts its namespace (38 ms on 10 000 checkpoints, instead of 1.7 ms). |
| MongoDB    | `npx agboss-mongodb migrate` is **mandatory before the 0.1.1 pods start**, and runs **after the old pods are stopped**: once the database is migrated, an old pod that restarts is refused (`MongoSchemaTooNewError`), but an old pod that is still running is not stopped by it. It applies the schema versions up to the build's (`checkpoint_latest_by_step`, version 2, the checkpoints' index `latest_by_step`; `pause-deadlines-and-notices`, version 3, the pause channels) and rewrites no checkpoint. | A 0.1.1 pod on a database at version 1 does not start (`MongoSchemaMissingError`, naming the command). Checkpoints written before get their `step` when their thread is first read: about 100 ms for a thread of 2 000 checkpoints, once per thread.                                                                                                                                                                                                    |
| SQLite     | A 0.1.0 file is not migrated: recreate it (the file of a 0.1.0 build, or of a development build, holds tables and no 0.1.1 stamp). A new file is stamped and its whole schema is created when the first 0.1.1 process opens it.                                                                                                                                                                                                                                                                                | The first 0.1.1 process refuses the old file at open (`StoreError.SchemaMissing`, code `store.schema-missing`) before it writes a row. A 0.1.0 process that is still running on a file is **not refused** (0.1.0 never reads the stamp): stop it first.                                                                                                                                                                                                 |

- **SQLite and an older version**: the column is generated, so 0.1.0's own `INSERT` of a checkpoint
  still works on a file 0.1.1 opened, and 0.1.1 reads what 0.1.0 wrote in order (#1035). A second
  process still on 0.1.0, or a rollback to it, does not break checkpoint writes — but it is not
  supported: the file is stamped, and **a later build** that finds a stamp above its own refuses the
  file at open (`StoreError.SchemaTooNew`, code `store.schema-too-new`, before it creates a table
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

## Errors — the classes are variants of families (#1325)

Every error class below is gone from `@agboss/core` (no alias); catch the variant, or its family for all of them. A variant is a sibling of the others of its family, never their subclass. A record's code line is `[variant code, family code, "agboss"]` (`step.failed` is gone).

| Was | Is | Code was → is |
| --- | --- | --- |
| `StepFailedError`, `PaidStepError` | `StepError` | `step.failed`, `step` → `step` |
| `AgentFailedError`, `AgentAnswerInvalidError`, `QualityGateError` | `StepError.Agent`, `.AgentAnswerInvalid`, `.QualityGate` | unchanged |
| `ActionFailedError`, `QuestionFailedError`, `GuardFailedError` | `StepError.Action`, `.ExternalTask` (`externalTask`), `.Guardrail` (`guardrail`) | `step.question` → `step.external-task`, `step.guard` → `step.guardrail` |
| `RouterFailedError`, `RouterDecisionError` | `StepError.Router`, `StepError.RouterDecision` (no longer a subclass) | unchanged |
| `ArbiterError`, `QuorumNotReachedError`, `ChildExecutionFailedError`, `PauseExpiredError` (`kind` → `pauseKind`), `ToolBlockedError` | `StepError.Arbiter`, `.QuorumNotReached`, `.Child`, `.PauseExpired`, `.ToolBlocked` | unchanged |
| `GuardrailBlockedError` (`guard` → `guardrail`), `PiiRefusedError` (`kind` → `piiKind`), `PiiDetectionFailedError` | `GuardrailError.Blocked`, `PiiError.Refused`, `PiiError.DetectionFailed` | unchanged |
| `LimitExceededError`, `BudgetExceededError`, `DeadlineExceededError`, `StepsLimitExceededError`, `VisitsLimitExceededError`, `DepthLimitExceededError`, `HopsLimitExceededError`, `MeshLoopDetectedError` | `LimitError`, `LimitError.Budget`, `.Deadline`, `.Steps`, `.Visits`, `.Depth`, `.Hops`, `.MeshLoop` (an agent's own limits: `LimitError.Agent`) | unchanged (`limit` → `limit.agent` for the last) |
| `GraphRuleError`, `ConfigurationError`, `EnvironmentError`, `EvalCaseInvalidError`, `NotAWorkflowStartError`, `WorkflowLoadError`, `ApplicationLoadError`, `ModelKindError` | `ConfigError.GraphRules`, `.ModelSettings`, `.Environment` (`envCode`), `.EvalCase`, `.NotAWorkflowStart`, `.WorkflowLoad`, `.ApplicationLoad`, `.ModelKind` | `graph.rules`, `eval.case-invalid`, `workflow.not-a-start`, `load.*`, `model.wrong-kind` → `config.*` |
| `UnknownThreadError`, `ThreadOwnerError`, `InvalidThreadIdError`, `DuplicateExecutionIdError`, `IncompatibleResumeError`, `CompensationFailedError`, `ExecutionCancelFencedError` | `ExecutionError.UnknownThread`, `.ThreadOwnerMismatch`, `.InvalidThreadId`, `.DuplicateExecutionId`, `.IncompatibleResume`, `.CompensationFailed`, `.CancelFenced` (a cancel, no hand-over) | `run.*`, `resume.incompatible`, `compensation.failed` → `execution.*` |
| `PauseClosedError`, `UnknownPauseError`, `PauseExtensionContendedError`, `ExpiryHandlerError` | `PauseError.Closed`, `.UnknownPause`, `.UpdateContended`, `.ExpiryHandlerFailed` | unchanged |
| `StoreOutcomeUnknownError`, `StoreCallTimeoutError` (no longer a subclass; `isStoreOutcomeUnknown(error)` is true for both), `StoredNamesUnreadableError`, `CostLedger*Error` | `StoreError.OutcomeUnknown`, `.CallTimeout`, `.UnreadableRecord`, `.Ledger*` | `stored.unreadable`, `cost-ledger.*` → `store.*` |
| `A2A*Error` (client) | `A2AError.*` | unchanged |

`ExecutionCancelledError` and its subclasses are internal now; `isExecutionCancelled` is in `@agboss/core/internal`.
