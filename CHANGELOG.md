# Changelog

All notable changes to the `@agboss/core` and `@agboss/cli` packages, one section per release, in the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) form; versions follow
[Semantic Versioning](https://semver.org/) (before 1.0 a minor release may break the API).

This file is the summary of each release. The detailed log — one entry per merged pull request,
with every breaking change, its reason and the migration — is the Wiki's
[Changelog](https://github.com/agbossjs/agboss/wiki/Changelog); the exact public surface of each
entry point is in `packages/agboss/api/*.api.md`. Security fixes are announced here too
([`SECURITY.md`](SECURITY.md)).

## [0.1.1] — 2026-11-05

The release in one line: several instances of one application share their trees safely — on SQLite
in the core, on PostgreSQL through `@agboss/postgres` and on MongoDB through `@agboss/mongodb`, with
`@agboss/redis` for the leases, the child queue and the rate limits (each released with it, on the
published core) — with every guarantee stated, its assumptions and the checkers that prove it (Wiki → Guarantees). Read **Changed —
breaking** first: an application upgrading from 0.1.0 needs at most the migrations listed there.

### Changed — breaking

- **The store entry, the fenced effect's service, the errors, `Turn`, the prune verbs** (#890, API
  review G8):
  - **`@agboss/core/stores`**, a new entry (its report `api/agboss-stores.api.md`): what a store
    outside the core is written with — the contracts, every type they name, the rows at a store's
    boundary (`OutboundCallIntent`, `OutboundCallClaim`, `OutboundCallState`, `OutboundCallLease`,
    `OutboundCallLeaseState`, `OutboundCallStep`, `OutboundCallStatusQuery`) and the core's store
    helpers (`assertEffectName`, `assertBusinessKey`, `fingerprintErrorOf`, `isKeyFingerprint`,
    `replayedFromOf`, `storedKeyFactsOf`, `StoredKeyFacts`, `effectKeyIdentityOf`,
    `pendingOutboundCallOf`, `remainingOf`, `idGeneratorNameOf`, `assertLedgerEntries`,
    `assertLedgerCutoff`, `expiredEntriesOf`, `unrecordedEntriesOf`, `InMemoryFencedEffectTransaction`).
    The rows and helpers left the root entry; the contracts and their records stay there too.
    `@agboss/postgres`, `@agboss/mongodb` and `@agboss/redis` import from it.
  - **`FencedEffects`**, a core service an application injects (`deps: [ExecutionContext,
FencedEffects]`) over the listed `FencedEffectRepository`: `runOnce(key, work)`, the work's
    transaction typed by the component (`(database: DatabaseSync) => …` on SQLite) — never a
    store's class in business code. The store's own `saveResultIfAbsent(key, work)` →
    `runOnce(key, work)` (it runs `work`; it never was a cache put). A test's
    `override(ListedStore, Replacement)` now reaches a contract the listed class implements (what
    `FencedEffects` injects), as a mock of that class already did; a workflow on its own (eval,
    replay, Studio) runs `FencedEffects` on the store of its infrastructure.
  - **Errors:** `IdempotencyKeyConflictError` → `BusinessKeyConflictError`
    (`fenced-effect.business-key-conflict`), `DuplicateThreadIdError` → `ThreadIdsExhaustedError`
    (`run.thread-ids-exhausted`), `FencedEffectAsyncWorkError` → `SyncWorkRequiredError`
    (`fenced-effect.sync-work-required`) — no aliases. An options bag for every new error of two
    facts or more, its keys the error's fields (`effect` on a fenced effect's, `call` on an
    outbound call's, `cause` in it): `InvalidMintedIdError({ generator, method, rule })`,
    `ThreadIdsExhaustedError({ generator, tries })`, `FingerprintNotJsonError({ effect, path,
reason })`, `InvalidBusinessKeyError({ effect, rule })`, `BusinessKeyConflictError({ effect,
businessKeyHash })`, `OutboundCallInFlightError({ call, … })`, `OutboundCallUnreconciledError({
call, …, reason, detail, cause })`, `OutboundCallResultNotStoredError({ call, …, reason })`,
    `OutboundCallSupersededError({ call, …, cause })`, `QuestionFailedError({ question, cause })`.
    `OutboundCallUnreconciledError.reason` is a code (`reconcile.unknown`, `reconcile.threw`,
    `reconcile.no-verdict`, `key-retention.passed`; what was said in `detail`) and
    `OutboundCallResultNotStoredError.reason` one of `outbound-call.payload-too-large`,
    `outbound-call.unmasked`, `outbound-call.result-unstorable`. `ExecutionFencedError.of({
scopeKey, token, observedToken })` reads and checks a scope key; `new ExecutionFencedError(…)`
    takes every fact and never throws. A static `code` is its literal (`as const`) on every error
    class no other error class extends.
  - **`Turn`:** `Tern`, `NewTern`, `TernOutcome`, `TernStatus`, `TernStep` → `Turn`, `NewTurn`,
    `TurnOutcome`, `TurnStatus` (a closed union of its statuses), `TurnStep`; the `Tern*` names stay
    as `@deprecated` aliases until 0.2.
  - **Prune verbs, `deleteBy<Field>Before(cutoff)`:** `PausedExecutionRepository.deleteResolvedBefore`
    → `deleteByResolvedAtBefore`, `MeshRequestRepository.deleteCreatedBefore` →
    `deleteByCreatedAtBefore`. A `Resolved` pause no step took when its tree ends (an answer a
    cancel won over, #811 s18c) is marked `Taken`, its answer kept, so the sweep removes it after
    `retention.pauseRecords` — it stayed `Resolved` forever before.

- **The execution audit log and the metric names** (#889, API review G6):
  - **The lease log is the execution audit log** — it keeps takeovers, hand-overs, fenced effects and
    outbound calls, not only leases. `ExecutionLeaseEventRepository` → `ExecutionAuditLogRepository`
    (`SqliteExecutionAuditLogRepository`; `@agboss/postgres` and `@agboss/mongodb` rename theirs the
    same way), `ExecutionLeaseEventRecord` / `ExecutionLeaseEventBase` / `ExecutionLeaseEventKind` /
    `LeaseEventStep` → `ExecutionAuditEventRecord` / `ExecutionAuditEventBase` /
    `ExecutionAuditEventKind` / `AuditEventStep`, `app.leaseEventsOf(tree)` →
    `app.auditLogOf(tree: ExecutionTreeQuery)` (`LeaseEventsQuery` → `ExecutionTreeQuery`, also
    `outboundCallsOf`'s), `ExecutionHistoryRecord.leaseEvents` → `auditLog` (and in `agboss records
export`), `@Application({ retention: { leaseEvents } })` → `retention.auditLog` (the old key is
    refused by `[application.retention-invalid]` naming the new one), the contract suite
    `executionLeaseEventContract` → `executionAuditLogContract` and
    `storeConformance({ stores: { executionLeaseEvent } })` → `stores.executionAuditLog`, the log
    code `lease-event.failed` → `audit-log.failed`. The stored tables and collections keep their
    names (`execution_lease_events`, `agboss_execution_lease_events`): no migration.
  - `LeaseTakeoverReason.Reacquired` (`"reacquired"`) → `LeaseTakeoverReason.Reclaimed`
    (`"reclaimed"`), the verb of `ExecutionLeaseRepository.reclaim`; the `reason` label of the
    takeover counter says `reclaimed` too.
  - The four hooks of the audit log are one exported type, `AuditLogHooks`, and every hook returns
    the exported `HookResult` — `ExecutionObserver` names no unexported type; the deprecated
    `@agboss/core/core` re-exports every `On*` hook it is made of too (no hook is a forgotten export there).
  - **Metrics:** `agboss.cluster.children.oldest_queued_seconds` → `agboss.cluster.children.oldest_queued.age`
    (unit `s`; no unit in the name), `agboss.instance.lease.takeovers` →
    `agboss.instance.leases.takeovers`, and `agboss.instance.compensations` labels its
    `CompensationStatus` as `outcome` (was `status`), as `executions.ended` does. Update scrape
    configs, alerts and scale rules that name them.

- **The application's configuration has one shape** (#834, API review G2):
  - **One `@Application({ retention })` group** — `{ pauseRecords, executionRecords, leaseEvents,
costLedgerEntries, fencedEffects, outboundCalls, meshAnswers, a2aTasks }`, each a `Milliseconds`,
    replaces `pauseRecordRetention`, `executionRecordRetention`, `leaseEventRetention`,
    `ledgerEntryRetention`, `fencedEffects.retention`, `outboundCalls.retention`,
    `mesh.idempotencyRetention` and `a2a.taskRetention` (the `a2a` option and `A2AApplicationOptions`
    are gone). Defaults are unchanged; `executionRecords` unset still keeps nothing. One rule,
    `[application.retention-invalid]`, replaces `[application.ledger-entry-retention-invalid]` and the
    retention halves of `[application.fenced-effects-invalid]` / `[application.outbound-calls-invalid]`:
    every retention a positive, finite duration, the fencing ones (`fencedEffects`, `outboundCalls`,
    `costLedgerEntries`) above the lease, none above a century, a key it does not know refused —
    and a retention set where it was before (a JavaScript caller, a cast) is refused naming where it
    goes now, never dropped for the default.
    Sizes and timeouts stay with their feature. A store's own `FencedEffectSettings` takes
    `FencedEffectSettingsOptions` (`{ maxResultSize?, retention? }`).
  - **Environment fields are made by helpers** — `EnvironmentField.secret()`, `.text()`,
    `.integer()`, `.flag()`, each `({ optional: true })`, replace the enum's eight values
    (`EnvironmentField.Secret`, `.OptionalInteger`, …). A literal does not compile; a value not made
    by them, or a key that is not a camelCase field name, is refused when `@Injectable` runs.
  - **`createApp(App, { env, profile, profileRoot, meterProvider })` only** — `processEnv`,
    `gateway`, `providerFetch`, `transport`, `connectMcp`, `container` and `branchScheduler` are seams
    of the internal build path (`testWith`, the CLI); a JavaScript caller's other key is refused,
    naming where it goes.
  - **`AppDeps`, `createAppDeps`, `AppDepsOptions`, `McpConnect`, `GraphDeps` and
    `ExecutionObserverManager` (with `EventMask`, `ObserverFailure`) left the root** (and the
    deprecated `/core`): they are `@agboss/core/internal`, with no public replacement
    (`agboss migrate imports` no longer moves `ObserverManager`).
  - **Units have one home, `@agboss/core/units`** (`Usd`, `Milliseconds`, `Bytes` and their makers):
    the root no longer exports `Usd` and `Milliseconds`.

- **The lease surface says what it does** (#847, API review G7) — the store contracts are new in
  0.1.1, so only a store or a test written against `main` changes:
  - **`StoreClock { source: StoreTimeSource.Database | Host | Test; now(): StoreTime }`** — one
    class replaces `DatabaseStoreClock`, `TestStoreClock` and `isDatabaseTime`; `StoreTime` is a
    branded `Date`, so a `Clock` passed where a fencing store takes its `StoreClock` does not compile.
    A networked store reads its database's time exactly when `source` is `Database`.
  - **The fencing token is `token` everywhere** — `ExecutionLease.leaseEpoch` and
    `PreviousLeaseHolder.leaseEpoch` are `token`, as on `ExecutionFence`, `EffectKey` and every event.
  - **`ExecutionLeaseRepository`**: `finish` → `retire`, its fault hold point `StoreHoldPoint.LeaseFinish` (`"lease.finish"`) →
    `LeaseRetire` (`"lease.retire"`), `saveExecutionIdIfAbsent` →
    `claimExecutionId`, the duration parameter `lease` → `duration`, and `yield` answers as `renew`
    does — `Milliseconds | undefined`, the time the lease has left (not extended), `undefined` once
    it is not the caller's.
  - **`ExecutionFence`**: `confirmNow()` → `renewNow()`, `confirmedUntil` → `trustedUntil`,
    `fenced(observedToken?)` → `fencedError(observedToken?)`; the testing fence's options follow
    (`trustedUntil`, `renewNowFails`).
  - **`ChildExecutionQueueRepository.findQueueDepth()` → `countByStatus()`**, its
    `ChildExecutionQueueDepth` → `ChildExecutionQueueCounts`.
  - Fencing semantics are unchanged: who holds a lease, when it expires and which write is refused.

- **The A2A client speaks A2A v1.0** (#809, epic #805): `A2AClient` / `@A2AAgent` are rebuilt on the
  official `@a2a-js/sdk` (1.3.0, exact pin) and call any v1.0 agent, AGBoss or foreign — the Agent
  Card at `<url>/.well-known/agent-card.json`, JSON-RPC or HTTP+JSON, `SendMessage` with
  `returnImmediately` through `OutboundCalls`, then `SubscribeToTask` or polled `GetTask`. Migration:
  `target.start` → `target.skill`; `target`, `input` / `output` are optional (an untyped or foreign
  agent); `send(input)` → `send(message)` returning `A2ATaskResult`, `cancel(threadId)` →
  `cancel(taskId)`, `call.threadId` → `call.contextId`; `A2ARemoteError` → `A2ARemoteCallError`
  (`a2a.remote`, an options constructor) beside `A2AProtocolError`, `A2AContractError`,
  `A2ATaskFailedError`, `A2ATaskCanceledError`, `A2ATaskInterruptedError`, `A2ACallDeadlineError`,
  `A2AOriginError`, `A2AMeshUnsupportedError`; `A2AContract` → `A2AClientContract`; `IA2AAdapter` →
  `A2AAdapterContract`; the zod values `A2AResponseSchema`, `A2AEventSchema`, `A2ARequestSchema` leave
  the public surface; `[a2a.target-required]` is gone. A v0.3-only agent is `A2AProtocolError`
  naming its version. The 0.1.0 client wire (`POST <url>/execute`, the `agboss-mesh` header) is gone:
  a 0.1.1 client and a 0.1.0 server do not interoperate (the server follows in #808).

- **A usage record has one ledger state; cost sources and categories are enums** (#817) —
  `UsageRecord.ledger?: LedgerMark` — `{ state: LedgerState.Written, ledgerId, madeAt: Date }` once
  a pass wrote it to the ledger as it was made, `{ state: LedgerState.RecordedElsewhere }` for a
  call of a child recorded on another instance, absent while it is not in the ledger yet — replaces
  `isRecordedElsewhere`, `ledgerId` and `madeAt` (ISO text); `ledgerMarkOf(record)` reads it, and
  reads a record kept before (a 0.1.0 checkpoint's `isRecordedElsewhere`) as the same state, so a
  state kept across the upgrade is never written or counted again. `CostSource` (`Api`,
  `PriceTable`, `Tool`) and `CostCategory` (`Agents`, `Routing`, `Guards`, `Review`, `Tools`,
  `Compaction`, `Retrieval`) are enums of the same strings — a `CostReport`'s JSON is unchanged, its
  amounts still `…Usd: number`. Every amount that crosses a store boundary is `Usd`
  (`LedgerEntry.costUsd`, `findSpentByCounter`, what `totalCost` sums of entries). The terms: cost —
  what one call cost; spend — what was consumed against a budget; usage — tokens only (CLAUDE.md,
  Wiki → FinOps). A checkpoint keeps JSON, so every read of one through the application's
  checkpointer gives each record's mark back as this version keeps it — its date a `Date`, a record
  of before in the one field —, and a mark it cannot read (or a field of before of another kind)
  fails the read rather than being taken as "not in the ledger". A cost below zero or no amount is
  refused where it enters (a decision model's or Jev's `cost`, tokens that price at `NaN`:
  `ModelCostError`), never subtracted from the counters. **Migration:** compare a record's source
  with `CostSource.Api` (not `"api"`), read `ledgerMarkOf(record)` instead of the three fields; no
  stored table changes. A checkpoint written by 0.1.1 marks its spend only in `ledger`, which a
  0.1.0 instance does not read: upgrade every instance of an application together, as the store
  migrations of this release already ask — never a fleet of both versions, never a rollback onto
  0.1.1's checkpoints. A spend's identity across passes (#810) is dated the same way:
  `LedgerKey.madeAt` is a `Date` (a checkpoint's ISO text read back as one; a key that cannot be
  read fails the read), and `LedgerDated` is gone with the record's own `madeAt`.

- **A question role cannot be declared** (#647) — `@ChannelRole({ ask, answer })` compiled and
  passed `agboss check`, but nothing could ask it: a tool naming it was `[channel.wrong-tool]` and
  no flow step pauses on one. The form is gone from `@ChannelRole`'s types
  (`ChannelQuestionRoleOptions` removed), its decorator throws
  `[channel.question-role-unavailable]` for a JS caller, and the docs and skills describe the
  approval form only; `[reply-interpreter.decision-model]` is gone with it (every role is an
  approval). Ask through an approval role (`approves`), a changed call through `overrideArguments`.
  Re-added in the same release with a flow step that asks it (#659, Added below).

- **`clock.advance` right after `app.execute` no longer races under `agbossVitest()`** (#646) — the
  first execution of a test file loads the core's lazy modules through vite's module runner, ~300
  turns of the event loop, and an execution of an app not built yet builds it first; `advance`
  waited one turn, so the time jumped before the execution reached its wait (05's step-slots test
  failed 3/3). Every dynamic import of the core is now `lazyLoad(import(…))` (lint-enforced), and
  `advance` waits for the loads in flight (30 s of real time at
  most, then `UnsettledWorkError`) before it moves the time. **Migration:** none for a test that awaited its execution's waits; `advance` now waits up to 30 s of real time for the core's loads in flight, then fails with `UnsettledWorkError` instead of moving the time too early.

- **A model reply interpreter sees the call it approves, and can say "not understood"** (#648) —
  its answer tool described `overrideArguments` as any object, and "not understood" was only
  "call no tool": cheap models read "ok but only up to $500" as a refusal and "🤷" as one too. Now
  `overrideArguments` is described by the approved tool's input, every field optional — the fields
  the reply changes, laid over the call's own arguments before validation — and a second tool,
  `answer-reply-interpreter-not-understood-dto` (`ReplyInterpreterNotUnderstoodDto { reason }`,
  `@agboss/core/dto`), keeps the pause pending with `UninterpretableReplyError` carrying the
  reason, as a code interpreter's `ReplyInterpretation.notUnderstood` does. Tests script it as
  `replyWith(ReplyInterpreterNotUnderstoodDto, { reason })`. **Migration:** a test that scripted "not understood" as no tool call scripts `replyWith(ReplyInterpreterNotUnderstoodDto, { reason })`; one that read a partial `overrideArguments` gets the merged call.

- **The budget's two exemptions failed open** (#656, found by a security review of #634): once any
  limit had been handled, every later action of the execution skipped the budgets — the branches a
  side path launched, what followed their join —, and an action that is some open entry's undo
  skipped them on any visit, also as a step of the main path. Both are now scoped to the side path
  itself, a record in the execution's checkpointed state (so a takeover or a resume reads it as the
  first run did): the side path that took a limit exempts its actions and what they lead to step by
  step, until a finish or a launch; an undo action is exempt only on a side path, undoing an entry
  that was open when the side path was entered. Elsewhere the exhausted budget stops it (an undo
  still runs, as the execution's automatic undo). **Migration:** a path that relied on running past an exhausted budget after a handled limit now stops with `BudgetExceededError` there; take it with its own `.onError(BudgetExceededError, …)`.

- **Knowledge bases are tenant-scoped** (#700) — an agent working for tenant A could be handed
  passages of tenant B's documents: the RAG contract had no tenant. Now the core passes the
  execution's tenant on every call — `retrieve(query, { topK, signal, tenantId })` and
  `index({ tenantId, signal })` (`RagRetrieveOptions`, `RagIndexOptions`) — and a connector must
  return and index that tenant's passages only, comparing the id as given. TypeScript does not flag
  a connector that ignores the field. **Migration for a connector of your own:** read
  `options.tenantId` in `retrieve` and `index`, key every stored chunk by it, and run
  `ragConnectorContract` (`@agboss/core/testing/contracts`) in your tests — it fails a connector that
  ignores or folds the tenant, appends on re-index, ignores `topK` or the signal, or reports a cost
  that is not a number from 0. Content every tenant may read (a public help center) is declared
  `RagTenancy.Shared` (#796, below). `SqliteFtsConnector`: nothing to change — its index file migrates itself on
  first open (the old chunks become the `default` tenant's; another tenant indexes its own copy on
  its first retrieval); `folder` may now be a function `tenantId → folder | undefined` for each
  tenant's own documents. `agboss rag index` takes `--tenant <id>` (default `default`); a retrieval
  outside an execution is `context.unavailable`. `KnowledgeSource`, `KnowledgeRetrieve` and
  `KnowledgeRetrieval` — the core's own view of a retrieval — are no longer public (#818, below).

- **A knowledge base declares whose content it serves** (#796) — a connector could ignore
  `tenantId` and still compile, and example 03's did: every tenant read one index. Nothing told a
  shared corpus from a forgotten tenant. `@Rag` now requires `tenancy: RagTenancy.PerTenant` (each
  tenant's own passages, read by `options.tenantId`; `ragConnectorContract` proves it) or
  `RagTenancy.Shared` (one corpus every tenant may read). Without it the decorator does not compile,
  and a JS project or a cast is `[rag.tenancy-required]` at assembly. `agboss describe` prints it
  (`rag: docs-rag (tool, k 3, per-tenant)`), and `describe --json` (each agent's `rag[].tenancy`),
  the profile schema and the `configHash` carry it. The core still passes the tenant either way.
  `agboss generate rag` writes `PerTenant`. **Migration:** add `tenancy` to every `@Rag`.
  `ragConnectorContract({ …, tenancy: RagTenancy.Shared })` (#818) runs the suite on a shared
  connector: in place of the isolation cases, every tenant — near-identical ids too — gets the same
  results, a re-index replaces the corpus for every tenant that read it, and a tenant the connector
  never saw is served, its calls carrying it. An unknown `tenancy` is refused, never an empty suite.

- **RAG names: one family, one word per quantity** (#818, the 0.1.1 API review) — `IndexReport` is
  `RagIndexReport`, `FtsOptions` is `SqliteFtsOptions`, its `dbFile` is `sqlitePath` (as the core's
  SQLite stores call it) and its `maxChunkChars` is `maxChunkLength` (characters); `KnowledgeSource`,
  `KnowledgeRetrieve` and `KnowledgeRetrieval` left `@agboss/core/rag` (the core's runtime view, the
  only RAG types without a tenant). `SqliteFtsConnector.retrieve` no longer writes on every read: a
  tenant never indexed is indexed by its first retrieval on the instance, once and whole, in one
  transaction — a failure midway leaves nothing for the next retrieval to mistake for an index (a tenant without
  documents used to re-run its index on every retrieval). **Migration:** rename the three names and
  the two options (`new SqliteFtsConnector({ folder, sqlitePath })`); a project that built on
  `KnowledgeSource` implements `RagConnector` instead. After the documents change, run `agboss rag
index` (as before) — a running instance does not re-read a folder on its own.

- **`@agboss/core/internal` is refused by lint, `studioOf` is public** (#818) — the official
  examples imported `studioOf` from `@agboss/core/internal`, which has no semver promise, and only
  this repository's lint config refused that entry. `studioOf`, `StudioOptions` and `StudioGraphs` are
  in `@agboss/core/testing`, and `@agboss/core/eslint` ships `agboss/no-internal-import` (every way
  a module names `@agboss/core/internal`), on in the `eslint.config.js` `agboss create` writes and in
  the examples. **Migration:** import `studioOf` from `@agboss/core/testing`; turn the rule on in an
  existing project (`plugins: { agboss: agbossPlugin }, rules: { "agboss/no-internal-import": "error" }`).
  Inside `/internal` (the CLI's contract, no promise): `executeUnchecked` is `executeWithoutInputCheck`
  (it skips the compile-time check of the input only — the run still validates it),
  `standaloneContexts` is `contextsOutsideExecution`, `FlowTypesWrite.strict` (set by nothing since
  #769) is gone, and six exports no one used are deleted (`byClassName`, `byComponentName`,
  `pathLines`, `defaultsLevelsOf`, `requestOfTask`, `TRAJECTORY_CHECK`).

- **Ids and keys must be a key's text** (#538, #547, #552, #556, #578, #589, #591) — a business key,
  a thread id, a tenant id, an `ownerId` and every id a project's own `IdGenerator` mints are now
  checked against `keyTextRuleOf`'s rules (1–200 characters, no control, format, invisible, private,
  unassigned or lone-surrogate code point, no look-alike space, NFC) and refused with a typed error
  naming the rule, never the value; a project's `IdGenerator` that repeats an execution id gets
  `DuplicateExecutionIdError`. **Migration:** ids that are plain printable text pass unchanged;
  normalize (NFC) and strip invisible characters before handing ids to the framework. Each change is
  under Guarantees and safety fixes below.

- **A test's `clock.advance` of a whole lease is a frozen holder** (#534, #533) — one advance of
  30 s or more past a live execution ends its lease even when no other instance took it, and a
  holder trusts its lease 29 s, not 30 s. **Migration:** to let time pass for a live holder, advance
  in steps shorter than the lease (`seconds(10)`). Details under Changed — breaking for stores
  outside the core.

- **A decision's `overrideArguments` pass the tool's input strictly** (#688) — from a reply, `app.resume`
  or a channel's `decided(…)`: a key the tool's input does not have, at any depth, is a
  `DtoValidationError`. Before, the input check stripped it and the raw value — the unknown key with
  it — reached the tool.

  **Migration:** a decision, reply correction or `decided(…)` that carried a key the tool's input
  does not declare now fails validation; send only the input's own fields.

- **A question step's input field is `ask`** (#802) — the field the step reads the role's ask from
  was `question` (`InputOf<Role>["question"]`), while `@ChannelRole({ ask })` and
  `PendingQuestion.ask` name the same value `ask`. `QuestionNodeOptions`, the step's node record
  `@ChannelRole` builds, is no longer exported from the root (no user writes it). A question
  step's `schemaHash` changes with its field's name.
  **Migration:** `InputOf<Role>["question"]` → `InputOf<Role>["ask"]`; rerun `agboss check`.

- **A pending pause's ask is read after narrowing on its `kind`** (#801) — `QuestionAsk` was
  `Readonly<Record<string, unknown>>`, which absorbed any property, so `result.pending[0].ask.arguments`
  compiled on the `PendingApproval | PendingQuestion` union as `unknown` and an approval's typing was
  lost silently. `QuestionAsk` is opaque now: a field of a `PendingPause`'s ask does not compile until
  `kind === PauseKind.Approval` (its ask then is `ToolCallApprovalAskDto`, typed as before); a question's
  ask is read as `const fields: Readonly<Record<string, unknown>> = pending.ask`. Renamed in the same
  change: `PendingPauseSite` → `PendingPauseBase`, and its `agent` → `step` (it names a question step
  since #659: the agent whose call waits, the agent that asks a question role through its tool, or the
  question step); `toHavePausedAt` compares `step`. `QuestionFailedError` takes an options object —
  `new QuestionFailedError({ question }, cause)` — and carries `readonly question` (also in `details`),
  its `static code` the literal `"step.question"`. **Migration:** narrow before reading `ask`
  (`if (pause.kind === PauseKind.Approval) pause.ask.arguments`); read `pending[i].step` for
  `pending[i].agent`.

### Changed — breaking for stores outside the core

- **The testing surface, reviewed** (#831, API review group 9; every name below is new in 0.1.1):
  - `@agboss/core/testing/faults` publishes the suite and the hold points only (82 symbols → 27):
    `faultSuite`, `FaultSuiteOptions`, `FaultShard`, `FaultStoreSet` (was `FaultStores`; no
    `defineFaultStores`), `FaultStoreTime`, `FaultBusinessRows`, `FaultEnvironment`,
    `FaultDatabase`, `FAULT_SCENARIOS` / `FAULT_SABOTAGE_SCENARIOS` (`FaultScenario`: id and title),
    `FaultInvariant`, `FaultInvariantError`, `FaultViolation`, `withHoldPoints`, `StoreHoldPoint`,
    `processHoldPoints` (`HoldPoints`, `HoldRequest`, `HoldPhase`, `HeldOperation`,
    `StoreAnswerLostError`), `OperationPhase`, `OperationEvent` and `reportHeldOperations({
instanceId, onOperation, onHeld })`, which returns its undo, in place of the writable
    `heldStoreSeam`. The pods, the cluster (`FaultWorld` → `FaultCluster`, internal), the gateway,
    the proxy, `ScaledClock`, `runFaultScenario` and the checkers are the suite's own;
  - `faultSuite({ storesModule })` (was `stores`, a module's path) shards itself (`shard: { index,
count } | "env"`, `AGBOSS_FAULT_SHARD=k/n`) and runs `FAULT_SABOTAGE_SCENARIOS` after the
    scenarios, each passing only when it breaks its invariant (`sabotages: false` skips them,
    visibly); its first case counts what runs, and every scenario it leaves out is a skipped case
    with its reason; `timeout` is a `Milliseconds`;
  - `storeConformance({ stores })` takes a `StoreSet` of `StoreEntry`s (were `ConformanceStores` /
    `ConformanceStore`), each built from a `StoreInstanceContext` (was `StoreSeam`); the fencing
    bundles are `FencedEffectTarget` / `OutboundCallTarget`; `InterleavingOptions.timeLimit` is a
    `Milliseconds`. A store declares its optional capabilities — `childExecutionQueue: { instance,
capabilities: [StoreCapability.WatchQueued] }`: a declared watch must pass its cases, an
    undeclared one is skipped on a store without `watchQueued` and fails on a store that has it
    (`[store-conformance.capability-not-declared]`). `VirtualClock`, `TestStoreClock` and
    `StoreCapability` come from `@agboss/core/testing/contracts` too, with `runConformanceSabotage({
root, fixtures })`, which runs a sabotage fixture in a vitest of its own and returns its cases
    (a fixture that does not load, or no case at all, rejects);
  - `@agboss/core/testing`: `leases.freeze(app)` / `leases.thaw(app)` take a `TestApp` (were
    `stall` / `resume` of any object); `testWith(App, { instances: [{ clockSkew, meterProvider }] })`
    (`TestInstanceOptions`) replaces `clockSkews` / `meterProviders`; `ClockSkew.drifting(rate)` (was
    `drift`); `callToolWithInvalidArguments` / `callToolWithTruncatedArguments` are typed like
    `callTool` (#679: a tool the agent does not list does not compile); `fence: { renewNowFails }`
    takes `boolean | Error`; `FakePaymentGateway` / `paymentGatewayChecklist` (were
    `FakeOutboundGateway` / `outboundGatewayChecklist`); `agbossVitest()` (was `agbossTest()`,
    `@agboss/core/testing/vitest`);
  - `VcrConfig.mode` is validated (#819): an unknown mode is `[vcr.unknown-mode]` before any model
    is asked, where it recorded against real models.

  **Migration:** rename as above; in a store package's fault suite pass `storesModule`, `shard:
"env"`, and drop your own shard helpers and sabotage test; give a child queue with `watchQueued`
  `capabilities: [StoreCapability.WatchQueued]`; replace `heldStoreSeam` writes with
  `reportHeldOperations`.

- **The fencing contracts' statics, paging and helpers** (#825, from the 0.1.1 API review):
  - one `static store: StoreDescriptor = { backend, leaseCheck? }` on `ExecutionLeaseRepository`,
    `FencedEffectRepository`, `OutboundCallRepository` and `A2ATaskRepository` (#824's `static
backend`) replaces `static backend`, `static leaseCheck` and `static leaseRepository`
    (`leaseCheck` absent is `LeaseCheck.Atomic`); one that is no descriptor — a backend that is no
    text, an unknown `leaseCheck`, a getter that throws — is `[application.store-descriptor-invalid]`
    at assembly, never read as undeclared or atomic; a unit runner finds a store's lease store by its
    `backend` — the runner's own, a listed one, or the core's SQLite one;
  - `findAllByTenantIdAndStatus({ tenantId, status, limit, after? })` → `OutboundCallPage { calls,
next? }`: keyset paging on an immutable order of the store's own (the core's SQLite store a
    declared `seq INTEGER PRIMARY KEY AUTOINCREMENT`, which a `VACUUM` or a restore keeps — a file
    written before is rebuilt with it), an opaque cursor, `next` absent on the last page, a limit
    that is no whole number from 1 a `RangeError` — the new conformance cases (`paged listing by
status`) fail a store that pages by an offset, names its cursor by a row that may be removed or
    takes any limit;
  - `checkedEffectName` / `checkedBusinessKey` → `assertEffectName` / `assertBusinessKey`;
    `fingerprintErrorOf` beside them, and `replayedFromOf` matches the previous idempotency key's
    fingerprint during a rotation (a store passes the row's facts as before); keys are made with
    `effectKeyForTesting(fields, changes?)` (a key is not spread: `effectKeyForTesting(key, { token })`);
    `markCompleted` / `markFailed`'s parameter is `attemptOwner`; the core's
    fencing stores take `Pick<StoreClock, "now">`.
    **Migration:** `static store = { backend: "postgres" }` in place of the three statics; page
    `findAllByTenantIdAndStatus`; `OutboundCallLeaseState.LeaseClosed` for `Superseded`.

- **The testing surface no longer passes what it did not check** (#799) — five fail-open defaults
  of the store author's suites:
  - a fault store set declares the time its fencing stores decide by, `FaultStoreSet.storeTime:
FaultStoreTime.Database | FaultStoreTime.Host` (required; `@agboss/core/testing/faults`), and
    the `linearizable` invariant reads the run's history on it — at 1 on a database's own clock,
    at the pods' `timeScale` on the host's. `FaultScenarioOptions.storeTimeScale` is removed: a
    database-clock set run at `timeScale: 5` without it was read five times too fast. A set without
    the field does not start its pods (`[fault-suite.store-time]`, `FaultStoreTimeError`);
  - `ragConnectorContract` reranks under `RerankFailurePolicy.FailStep`: a reranker that throws or
    returns a passage that is no candidate fails the cases, where the fallback to the retrieval's
    order passed them;
  - `storeConformance`'s explorer: `interleavings: false` shows `interleavings (<name>)` with one
    skipped case; a `depth`, `walks` or `walkDepth` that is not a whole number of at least 1 (`walks: 0`, a
    negative depth, a fraction), a seed not whole, a `timeLimit` not positive or an unknown key is refused, `[store-conformance.invalid-interleavings]`; a set with
    a fenced-effect or outbound-call store explored below depth 4, 20 walks of 16 steps — or not at
    all — fails `store set (<name>)`'s case `explores its fencing stores at least at the floor …`
    (`[store-conformance.interleavings-below-floor]`);
  - `store set (<name>)` lists every contract the set does not claim as a skipped case, `does not
claim stores.<key>`; the child queue's two watch cases are skipped, with the reason, for a store
    without `watchQueued` — they passed — and fail for one with it on one instance only;
  - `paymentGatewayChecklist`'s `isPassed` means every requirement was probed and passed: G3
    skipped for lack of a clock is no longer a pass, and G5 passes only when the same amount
    under a fresh key goes through after the refusal — a gateway that is down refuses everything.

  **Migration:** add `storeTime` to your `faultStores` (`FaultStoreTime.Database` for a store that
  reads its database's clock — PostgreSQL, MongoDB —, `FaultStoreTime.Host` for one on the process's
  clock) and drop `storeTimeScale`; explore a fencing set at least at the floor; read a checklist
  report's `results` for what was skipped.

- **A pause record stores its `kind` and names its `step`** (#801) — `PauseRecord.kind: PauseKind`
  is written by the step that pauses and kept as written; `isQuestionPause` reads it, and a store no
  longer tells a question from an approval by `component?.kind`. `PauseRecord.agent` is `step`. The
  paused-execution contract checks it (`a pause's kind is kept as written — never inferred from its
component`: a question with no component, an approval whose component reads as a question); a store
  that drops `kind` and infers it fails that case. The SQLite store rewrites a row written before at
  open (`agent` → `step`; `kind` `question` for a question role's component, `approval` otherwise) —
  a file opened by 0.1.1 is not read by 0.1.0 again. A `kind` other than the two throws when read,
  never taken for an approval; `questionAskOf` (a store's read-back of a question's ask) throws on
  anything but an object.
  **Migration:** a pause store of your own persists both fields (agbossjs/postgres: migration
  `0024`; agbossjs/mongodb reads a record written before by the same rule).

- **A lease store keeps every execution id handed out** (#591) — `ExecutionLeaseRepository` has a
  new abstract `claimExecutionId({ executionId, tenantId }): Promise<boolean>`: one atomic
  insert-if-absent by the id alone (across tenants: a step's idempotency key and the key an
  outbound call sends with no business key carry no tenant), `true` for a new id, `false` for one
  any execution ever had; never removed. The lease contract checks it (`an execution's identity`:
  once, across tenants, a race of eight claims on two instances with one winner, exact comparison,
  kept after the lease is released or finished). The SQLite store's `execution_ids` table is filled
  on a file of an older version, with its first new id, from `execution_leases` and (#638) from
  `outbound_calls` — the executions that made a call, a `ParentInstance` child's too: its step-keyed
  key reached the other system, which would answer a new execution of that id with the old call's
  response. **Migration:** a lease store of your own implements the method on its lease backend, its
  ids of before from its leases and its outbound calls (agbossjs/postgres: migrations `0018`, `0019`).

- **An opted-out store is never conformant for fencing** (#543) — `storeConformance` (and
  `fencedEffectContract` / `outboundCallContract`, `{ acceptWithoutDoubleChargeProtection }`) fails
  every fencing case of a store that declares `LeaseCheck.WithoutDoubleChargeProtection`
  (`[store-conformance.opted-out-store]`) unless the call says
  `acceptWithoutDoubleChargeProtection: true`; then those cases are skipped — never passed — with
  "store opted out of the lease check: no double-charge protection", every other case runs, and the
  set shows `gives NO double-charge protection for fenced effects | outbound calls`; a fencing
  contract run on its own with the flag shows `gives NO double-charge protection: its store opted
out of the lease check (acceptWithoutDoubleChargeProtection)` in its own suite — passing for an
  opted-out store, failing (`[store-conformance.opt-out-not-declared]`) for one that does not opt
  out —, so a report that hides skipped cases still says it (#543 acceptance). Before, an
  atomic store with the flag on passed every case and an honest one could pass none. The start's
  `[application.lease-check-not-atomic]` links Wiki → Your-own-store. **Migration:** a set with an
  opted-out store adds `acceptWithoutDoubleChargeProtection: true`.

- **One transactional backend, checked at assembly** (#526) — `ExecutionLeaseRepository`,
  `FencedEffectRepository` and `OutboundCallRepository` declare `static store = { backend }` (#825; `"in-memory"`,
  `"sqlite"`; `"postgres"`, `"postgres:billing"` for a store of your own): a listed fenced-effect or
  outbound-call store and the application's lease store must declare the same one —
  `[application.store-backend-mismatch]` names both classes and backends, a store that declares none
  fails `[application.store-backend-undeclared]` (it used to be skipped). The explicit opt-out
  `static store = { backend, leaseCheck: LeaseCheck.WithoutDoubleChargeProtection }` is not checked and warns
  `[application.lease-check-not-atomic]` (an error under `agboss check --strict`). Rate limits, the
  child queue and the lease log may be on any backend. `[application.fenced-effect-lease-store]` is
  gone; unit runners find a store's lease store by its backend (#825). **Migration:** add
  `static override readonly store: StoreDescriptor = { backend: "<your backend>" }` to your lease,
  fenced-effect and outbound-call stores.

- **A lease is over at its expiry, for its holder too** (#534) — a lease is live while
  `expiresAt > now`, and only then: at `now >= expiresAt` `renew` (held or yielded) and `yield` are
  `undefined`, `reclaim` is `undefined`, `fence.renewNow()` loses the lease and every fenced write and
  outbound-call write under it is `ExecutionFencedError` — whether another instance took it or not;
  the holder takes its tree again only by `acquire`, at a new epoch, a takeover from itself. The
  in-memory and SQLite stores renewed a lease past its expiry when nobody had taken it, PostgreSQL
  refused it (except at the exact instant); every store now draws the same line as `acquire`,
  `leaseStateOf` and the fence checks. New contract cases at `expiresAt − 1 ms`, exactly at it and
  `+ 1 ms` for `renew`, `yield`, `reclaim`, the framework's `renewNow()` and renewal, a fenced
  write, an outbound call's intent and `leaseStateOf`; the cases "a lease renewed exactly at expiry,
  not taken meanwhile, is kept" and "a yielded lease reclaimed exactly at its expiry…" are gone.
  **Migration:** a store of your own matches `expires_at > now` (not `>=`, not holder and epoch only)
  in `renew`, `yield` and `reclaim`. In tests, one `clock.advance` of a whole lease (30 s) or more is
  a holder frozen past its expiry, so its lease is lost even when no one took it: to let time pass
  for a live holder, advance in steps shorter than the lease (`seconds(10)`).
  `ExecutionLeaseLostError`'s message no longer says another instance took the lease (#551): since
  #534 a renewal or a reclaim at the expiry is refused whether or not one did, so it says the lease
  is over — expired, or taken — and that the next take continues the execution. Nor do the other
  ways a lease ends (#567): a fenced write the core's stores refuse for an expired, released or
  missing lease (`ExecutionFencedError`, the same token seen) says the lease is over, not "another
  instance holds the lease" — only a newer token seen names a newer take and its holder — and a
  holder whose lease ran out here with no renewal confirmed (frozen, or its store not answering)
  says the next take continues, not "another instance continues". Fields and codes unchanged. An
  execution `app.close()` interrupts at its shutdown timeout (`ApplicationStoppingError`, #582)
  says it stays running and the next take of its lease continues it — another instance, or this
  application once it starts again — not "another instance continues it".

- **The store's time decides a lease's expiry; the holder fences itself on elapsed time** (#533) —
  instances whose wall clocks disagree no longer disagree on when a lease ends.
  `ExecutionLease.remaining` (new, required) is the time the store says the lease has left;
  `ExecutionLeaseRepository.renew` answers it (`Promise<Milliseconds | undefined>`, `undefined` once
  the lease is over) instead of `true` / `false`, and `acquire` and `reclaim` return it on the lease.
  The holder trusts its lease until `sentAt + remaining − LEASE_SAFETY_MARGIN` (1 s), `sentAt` its
  time when it sent the request, counted on its monotonic clock (`Clock.monotonicNow()`, new:
  `performance.now()` unless a clock overrides it) and on its wall clock, the earlier ending it — an
  offset moves neither, a step back is bounded by the monotonic count, a step forward or a host
  suspend by the wall count; a `remaining` that is not a finite number ≥ 0 is 0 (the holder fails
  closed), one above the lease asked for is that lease; the margin covers
  the drift of the holder's and the store's clocks over one lease, ≤ 1 s / 30 s together. The
  framework's renewal now reaches the store with 19 s of trust left (9 s after a failed one), and an
  outbound call's `send` starts only while the holder's fence holds. `StoreClock` (new; `TestStoreClock` in `@agboss/core/testing`) is the time a
  store decides by: a networked store's database time in production, the host's clock for in-memory
  and SQLite — and in `testWith` and the contract suites the test's clock, unskewed, injected through
  the seam (`StoreInstanceContext.storeClock`). `testWith(App, { instances: [{}, {
clockSkew: ClockSkew.ahead(seconds(300)) }] })` (new) skews an instance's clock — wall time, monotonic time and
  sleeps — over the test's. New contract cases run on real time with the other instance's clock off
  by ± lease/2, ± lease and ± 10 × lease: a store that decides by the caller's clock fails them.
  **Migration:** return `remaining` (`remainingOf(expiresAt, now)`, both on the store's clock) from
  `acquire`, `renew` and `reclaim`; a networked store compares and writes `expires_at` with its
  database's time inside each statement (PostgreSQL `clock_timestamp()`) unless
  `StoreClock.source` is not `StoreTimeSource.Database` (a test's clock), and builds from `seam.storeClock` in its
  contract target. A test that expected a holder to trust its lease for the full 30 s counts 29 s.

- **The rules of a fenced key are exported** (#526) — `checkedEffectName`, `replayedFromOf` (a row's
  `null`s taken, a stored step checked: `StoredKeyFacts`), `storedKeyFactsOf`, `effectKeyIdentityOf`
  and `pendingOutboundCallOf` from `@agboss/core`, so a store outside the core keeps no copy of them.
  `FencedEffectStoreMismatchError` and `FencedEffectResultTooLargeError` moved modules (still exported
  from the root).

- **A store's connection need not be listed** (#526, found by agbossjs/postgres#8) — with
  `OutboundCalls`, or a component that injects a store's own class, an unlisted `SqliteConnection` or
  `PostgresConnection` no longer fails assembly with `"…Connection" is not registered`: the workflow
  graph check takes an unlisted class under an infrastructure implementation as its own registration,
  as the container creates it.

- **`storeConformance`** (#526) in `@agboss/core/testing/contracts` — one call runs every contract a
  store set claims (`stores: { executionLease, fencedEffect, outboundCall, executionLeaseEvent, … }`)
  and the `store set (<name>)` cases (each fencing store declares its `static store` backend, one with its
  lease store's); a set with a lease store that leaves a fencing contract out throws
  `StoreConformanceError` unless `without` says it has none. New contract cases, which a store
  outside the core must pass: every lease-log row kind and #508 field read back as it was, a
  fenced-effect key built by hand with an invalid name refused (`InvalidFencedEffectNameError`, also
  for an empty name, which was a `TypeError`), and a zombie's write racing the new holder's leaving
  one business row. The Wiki's [Your own store](https://github.com/agbossjs/agboss/wiki/Your-own-store)
  page: what each contract must make atomic, recipes for SQL, MongoDB, Redis, DynamoDB and Cassandra.

- **The ledger's entries are pruned, and a write of one it may have pruned is refused** (#771) —
  every tallied spend is an entry under its `ledgerId` (#727), dated by its `madeAt`.
  `CostLedgerRepository` has a new abstract `deleteByMadeAtBefore(cutoff: Date)` (#817: the house
  verb `deleteBy<Field>Before`): it raises the store's pruning mark to `cutoff` (never lowers it) and
  removes the entries made before it, atomically against a save; the recovery sweep calls it every
  look with `now − @Application({ retention: { costLedgerEntries } })` (default `hours(24)`, above the
  lease — `[application.retention-invalid]`). `saveAll` refuses an entry made before the mark
  that it does not hold — `CostLedgerEntryExpiredError` (`cost-ledger.entry-expired`), nothing of
  the save added — so a lost answer retried after its entry was pruned is never counted twice (the
  pass's reads fail with it); one retried within the retention counts once, as before. The
  `costLedgerContract` checks the prune, the refusal, the mark that never goes back (to the
  millisecond, #817) and saves racing a prune. **Migration:** a ledger of your own keeps each
  entry's `madeAt` and a pruning mark read with the insert; the SQLite store dates the entries of a
  #727 file "never" (agbossjs/postgres: migration `0023`; agbossjs/mongodb: `madeAt` on
  `agboss_cost_entries`).

- **A ledger saves ledger entries only** (#817) — `CostLedgerRepository.saveAll(counters, entries:
readonly LedgerEntry[])`: a `LedgerEntry` is a `UsageRecord` with its `ledgerId`, its `madeAt:
Date` and its `costUsd: Usd`, so a record without an identity — which the contract before added on
  every save, a retry counted again — does not compile, and a JS caller's (or a cast's) is refused
  at run time: `CostLedgerEntryInvalidError` (`cost-ledger.entry-invalid`: `index`, `reason`),
  nothing added, by `assertLedgerEntries(entries)` — what every store calls first; a prune's cutoff
  that is no valid `Date` likewise: `CostLedgerCutoffInvalidError` (`cost-ledger.cutoff-invalid`:
  `reason`, #869), nothing pruned, by `assertLedgerCutoff(cutoff)`. The core saves
  every spend as an entry, a step's end and an evaluation's judge calls too. The store helpers take
  and give `Date`: `unrecordedEntriesOf(entries, isNew: (ledgerId, madeAt: Date) => boolean)` (was
  `newEntriesOf`, its callback given ms) and `expiredEntriesOf(entries, prunedBefore: Date |
undefined, isHeld)`, now exported (the half that refuses); both in the root for now. New contract
  cases: anything but an entry refused before anything is added (with counters or none), the mark
  kept to the millisecond, a prune whose cutoff is no valid `Date` refused with the mark where it was
  (each with a naive store that fails it). **Migration:** a ledger of your own takes
  `readonly LedgerEntry[]`, calls `assertLedgerEntries` first, renames `deleteEntriesByMadeAtBefore`
  to `deleteByMadeAtBefore` and `newEntriesOf` to `unrecordedEntriesOf` (its callback's `madeAt` a
  `Date`); the stored tables are unchanged.

- **`ChildExecutionQueueRepository.countByStatus()`** (#485) — a new abstract method: one read of
  the queue's `ChildExecutionQueueCounts { queued, running, oldestQueuedAt? }`, which the cluster
  gauges of the autoscaling metrics read once per collection. **Migration:** a child queue of your
  own answers it in one query (agbossjs/postgres, agbossjs/mongodb and agbossjs/redis do).

### Deprecated

- **`VCRMode` → `VcrMode`** (#802) — the cased-as-a-word name, as `VcrConfig` and the `vcr` option.
  `VCRMode` stays a deprecated alias of the same enum until 0.2 (its value, its type, a member as a
  type); `npx agboss migrate imports` rewrites the import.
- **The deprecated entry aliases are removed in 0.2** (#802) — `@agboss/core/channels`, `/core`,
  `/graph`, `/router` and `/tool` (each re-exports the root, `package.json#deprecatedExports`) go in
  0.2; import from `@agboss/core` (`npx agboss migrate imports` rewrites them).

### Security

- **An A2A client talks to its own origins only** (#809): an Agent Card interface on another
  origin than the client's `url` (or its `allowedOrigins`) is refused, no request — and so no
  credential header — goes elsewhere, and redirects are never followed off those origins.
- **A signed mesh envelope always names its audience** (#809): senders sign only when they name the
  receiving application (else the envelope is an unsigned, untrusted claim), and the receivers'
  shared check (`audienceRefusalOf`) refuses a signed envelope with no `audience`
  (`mesh.audience-missing`) or another's (`mesh.audience-mismatch`) before its signature is
  verified — today an MCP server's (an error result with that code); the A2A server's mesh check
  comes with #810. A signed claim could otherwise be replayed to another application. An MCP or A2A client without a target application
  is no longer trusted by its receiver. `signedMeshEnvelope` takes a required `audience`.

- **No CI install takes a release nobody reviewed** (#523): every workflow installs from its
  lockfile (`npm ci`); an install that must resolve ranges — `npm run check:packed`'s probe project
  — takes no release younger than three days (`npm install --before`, `AGBOSS_NPM_BEFORE` for the
  maintainer at release time); an `npx` only at an exact version. `npm run check:installs` (in
  `make check`) enforces it; the same in agbossjs/postgres and agbossjs/agboss-examples.
  `RELEASE_CHECKLIST.md` → Dependency installs states the policy.

- **`@agboss/cli` no longer installs `extract-zip`** (#791) — it came with `@langchain/langgraph-cli`
  (its `langgraphjs new` template download, through `create-langgraph`), which `agboss studio` never
  used, and has two high advisories with no fixed release (GHSA-jmr9-qjv8-65gv,
  GHSA-7pqw-9j4j-h8q3). `agboss studio` now starts the LangGraph dev server on
  `@langchain/langgraph-api` (pinned at 1.5.5) itself, doing what `langgraphjs dev` did — the same
  command, options, server, Studio URL and browser tab; no usage analytics are sent. A fresh install
  of the CLI audits with no high or critical finding (`npm audit --omit=dev`); the two moderate ones
  left are `@hono/node-server` 1.x, which `@hono/node-ws` (under `@langchain/langgraph-api`) requires
  and no 1.x release fixes. `check:packed` fails on an install that holds `extract-zip` again.

- **A model the framework calls for an agent reads through that agent's PII policies** (#708) —
  the core's LLM reranker sent the query and the candidates to its model unmasked, and so did a
  model judge in an agent's quality gate and a model arbiter. Each now reads as the agent's own
  model does: its PII policies, its execution's sensitive values and key; a block rule refuses
  before any model reads the text. A launch's copy (`agent#2`) reads through its agent's policies
  and an element no list names through the workflow's, never none; only a real image part's
  `data:` URL is exempt from a judge's masking.

### Fixed — guarantees and safety

- **A pause's decision carries no file descriptor** (#900, after #859) — a follow-up message that
  resumes an `INPUT_REQUIRED` task with `{ pauseId?, decision }` holding an object shaped as an
  `A2AFileDto` (a `mediaType` with a `fileId`, `sha256`, `inline` or `url`) at any depth is refused
  `-32602 a2a.file-field-in-data`, nothing resumed, as a start's data part naming a file field is:
  a file's descriptor is the server's, made when a file part is admitted. The scan is iterative and
  bounded (64 levels, 10 000 values, else `-32602 a2a.answer-shape`).
- **A business key's fingerprint is required, and keyed by an idempotency secret of its own** (#825,
  from the 0.1.1 API review, G1b and G5) — under a business key a fenced effect without a
  `fingerprint` had none, so two effects with the same business key and other work (a charge and a
  refund of `order:42`) silently replayed each other; and every fingerprint was keyed by the PII key
  (`pseudonymKey`), with no rotation and an unkeyed SHA-256 without one:
  - `effectKeyOf(executionContext, name, { businessKey, fingerprint })` — or `fingerprintPolicy:
FingerprintPolicy.None`, the explicit opt-out for work the business key fixes by itself — for a
    fenced effect; `{ businessKey }` alone is an `OutboundCallKey`, which only `OutboundCalls.send`
    takes (its request is its fingerprint, as before). A fenced effect under a business key without
    either does not compile; a JavaScript caller or a cast is refused before any transaction
    (`FingerprintRequiredError`, `fenced-effect.fingerprint-required`, `reason`: `FingerprintProblem.Missing`
    / `Contradictory`; `fingerprintErrorOf` for a store of your own) — at the store's entry and again
    in the core stores' own transaction, so a subclass's entry cannot skip it; `OutboundCalls.send`
    refuses `FingerprintPolicy.None` (a call's request is its fingerprint); a fingerprint that is not
    plain JSON (a DTO instance, a `Date`) is `FingerprintNotJsonError`
    (`fenced-effect.fingerprint-not-json`, naming the effect and the path, never the value);
  - `EffectKey` and `OutboundCallKey` are marked by a private member, which an object literal and a
    spread lack: `effectKeyOf` is the only maker for an application, a forged key (`{ ...key, token:
key.token + 1 }`, `{ ...key, fingerprint }`) does not compile, and a key the framework did not
    make (a JavaScript caller's, a cast) is refused at run time before anything runs; a store's or a
    contract's tests make one with `effectKeyForTesting(fields, changes?)`
    (`@agboss/core/testing/contracts`; `EffectKeyFields` its fields);
  - an automatic undo — a root's, a child's in its parent's node — makes its business keys as its
    step did: its frame carries the application's idempotency keys and the PII key of the
    handle (#825 acceptance: a refund under `refund:<charge>:1` in an undo was
    `IdempotencyKeyMissingError`, the undo `CompensationFailedError`);
  - `@Application({ idempotencyKeyField })` names a `Secret` field used only for business-key
    fingerprints (`HMAC(HMAC(key, "agboss/fingerprint/v1"), canonical JSON)`) — required once a
    component or a listed service reaches `OutboundCalls`, a fenced-effect store or the outbound-call
    store through its `deps` (an abstract dependency by the listed class it is given, an
    `InjectionToken` by its value's class)
    (`[application.idempotency-key-required]`), never an unkeyed digest (a key made without it is
    `IdempotencyKeyMissingError`, `fenced-effect.idempotency-key-missing`). `previousIdempotencyKeyField`
    rotates it: fingerprints are compared under both keys (`EffectKey.previousFingerprint`, never
    stored, `isKeyFingerprint`) and stored under the current one, so an intent recorded before the
    rotation and retried during it replays or is reconciled — no conflict, no second call — and once
    the previous key is removed what was stored under it fails closed (a conflict, nothing sent);
    `testWith` and the unit runners give a key field with no value a test key — the test
    environment may leave it out —, as #778 does the PII key;
  - `pseudonymKey` is `piiKeyField`, typed as a `Secret` field of the environment contract
    (`SecretFieldOf<TEnvironment>`: a typo or a text field does not compile; the idempotency fields
    too); a key field that is also a model provider's `apiKey` (the built-ins' `openRouterApiKey`
    when none is listed), the mesh's `signingKey`, a `Secret` a listed class reads or another key
    field is `[application.pii-key-shared]` / `[application.idempotency-key-shared]`, and a key
    field whose `Secret` reads another key's variable fails the start, naming both fields; a named
    key field without a value fails the start, naming it (a named `piiKeyField` too — it no longer
    falls back to a key of the instance), and one that holds no `Secret` too.
    **Migration:** a fenced effect under a business key names its `fingerprint` (or
    `fingerprintPolicy: FingerprintPolicy.None`); `pseudonymKey` → `piiKeyField`; an application that
    uses business keys adds `idempotencyKey?: Secret` to its contract, `idempotencyKey:
secret("IDEMPOTENCY_KEY")` to each environment it runs on (not `test`) and `@Application({ idempotencyKeyField:
"idempotencyKey" })` (business keys are new in 0.1.1: no released row is keyed otherwise).

- **Reads and names of the outbound-call surface** (#825, from the 0.1.1 API review) —
  `app.pendingOutboundCalls(tenant)` returned every pending intent of a tenant at once; it is
  `app.pendingOutboundCallsOf({ tenantId, limit?, after? })` → `OutboundCallPage { calls, next? }`
  (default 100, at most 1000, `dto.invalid` otherwise — a cursor the store never gave too; the store
  itself refuses a limit that is no whole number from 1 with a `RangeError`), keyset-paged on the store's record order: a
  call pending for the whole read is listed exactly once, whatever is recorded, ends or is pruned
  between pages. `OutboundCalls(repository, settings, logger, clock)` takes every parameter (it
  logged nothing and ran on the wall clock when built by hand; a JavaScript caller's missing one is a `TypeError`), and a logger that throws is said once on the process (`process.emitWarning`, `AGBOSS_LOGGER_FAILED`), never swallowed in silence); `OutboundCallReconciliation` is a
  union by `verdict` (`CompletedReconciliation { result }`, `NotSentReconciliation`,
  `UnknownReconciliation { reason }`), still built only by `completed` / `notSent` / `unknown`.
  Names: `JsonResult` → `JsonValue`; `OutboundCallOutcomeStatus` → `OutboundCallSendStatus`; the three
  meanings of "superseded" apart — `OutboundCallLeaseState.Superseded` → `LeaseClosed`
  (`lease-closed`), the lease log's `OutboundCallEventOutcome.Superseded` → `AttemptSuperseded`
  (`attempt-superseded`) and `LeaseSuperseded` → `LeaseClosed` with `closedLease`
  (`OutboundCallClosedLease`, was `supersededLease`), the warning `outbound-call.lease-closed`; rows
  written before are read with the new names (`app.leaseEventsOf`, kept records).

- **The outbound-call contract fails closed** (#795, from the 0.1.1 API review) — three defaults
  that failed open and two names that misled, changed before the surface is published:
  - every `OutboundCalls.send` says how far its `notSent()` is trusted, a required `notSent`:
    `{ trust: NotSentTrust.Lookup }` (the lookup reads a record that does not expire, trusted at any
    age) or `{ trust: NotSentTrust.KeyReplay, keyRetention: hours(24) }` (the other system's replay
    of the key, refused past its retention as `keyRetention` was). The optional `keyRetention` —
    "unset: `notSent()` is trusted at any age" — is gone; leaving `notSent` out does not compile,
    and a JavaScript caller without it, with an unknown trust or a bad retention is refused before
    anything is recorded or sent (`InvalidNotSentTrustError`, `outbound-call.invalid-not-sent-trust`);
  - an attempt answered after a newer one took its intent over — both reached the other system —
    fails the step with `OutboundCallSupersededError` (`outbound-call.superseded`, a
    `StepFailedError`: `call`, `target`, `operation`, `idempotencyKey`, `attempt`, `supersededBy`),
    never a normal outcome; `OutboundCallOutcomeStatus.Superseded` is removed (the lease log's
    outcome stays, named `OutboundCallEventOutcome.AttemptSuperseded` by #825);
  - `new OutboundCallSettings({ …, requiresMask })` takes one options bag whose `requiresMask` is
    required (`OutboundCallSettingsOptions`), where a positional boolean defaulted to `false`; a
    JavaScript caller without it gets `true`;
  - the shared key is `effectKeyOf` / `EffectKey` / `EffectKeyOptions` / `effectKeyIdentityOf`
    (was `fencedEffectKeyOf`, `FencedEffectKey`, `FencedEffectKeyOptions`, `fencedKeyIdentityOf`);
    options are the input and settings the resolved value — `FencedEffectOptions` +
    `FencedEffectSettings`, `OutboundCallOptions` + `OutboundCallSettings` (was
    `FencedEffectsOptions`, `OutboundCallsOptions`), the per-call options of `send`
    `OutboundCallSendOptions` (was `OutboundCallOptions`). The fault suite's sabotage
    `s15-sabotage-retention-undeclared` is `s15-sabotage-replay-trusted-as-lookup`; a
    superseded definite failure and a call joined to a superseded one fail so too.

- **MongoDB: a missing ledger pruning mark counted spend twice** (#798, agbossjs/mongodb) — the
  #771 mark was created by the first prune, so a mark deleted by hand read as "never pruned", and a
  pruned entry saved again by a late pass was counted a second time. The mark is now made with
  `agboss_cost_entries`, in the transaction that creates it, and a save or a prune without it — or
  with a `prunedBefore` that is no date — fails closed with `MongoLedgerMarkMissingError`
  (`mongodb.ledger-mark-missing`), adding and deleting nothing, as `PostgresLedgerMarkMissingError`
  does. A restart never seeds it again. The message is the remedy.
  `@agboss/redis` keeps no ledger.

- **Another tree's approval was dropped from the history** (#676, after #663) — the pause answer
  log kept one answer per tenant and step key, and a step key names no tree: a pause of another
  tree under the same key (an id minted again that the kept ids miss) was asked again since #663,
  but its answer never reached `record.pauses`. The log is now one answer per pause of a tree
  (tenant, `rootExecutionId`, step key): the SQLite record store's migration 15 rebuilds
  `pause_answers` with every row and rowid kept; `executionRecordContract` gains the case.

- **A child's result lost when the host's clock stepped back** (#661) — a child's end was read at
  its thread's latest checkpoint, the greatest id — LangGraph's UUIDv6 of `Date.now()`. After a
  backward step of the wall clock (an NTP `settimeofday`: −50.8 ms where it was seen) the child's
  newest checkpoints sorted before older ones, the one before its action looked ended, and the
  parent got `undefined` for its result (a `DtoValidationError` at the parent's finish, or a value
  missing on the path). Now a child's end is read at the checkpoint its own run wrote last — a
  re-entered child and a remote child's parent at its thread's leaf —, on either placement.

- **A resume after the host's clock stepped back skipped the approved call** (#682) — LangGraph
  continues a resume, a recovery or a re-entered child from a thread's latest checkpoint, the
  greatest id. After a backward step it continued from the checkpoint before the step: the agent
  ran its earlier tool again and the approved charge never ran, though the run finished
  "Charged.". The application's checkpointer — whatever saver is listed, PostgreSQL's too — now
  reads the checkpoint written last: a write whose id sorts below its thread's greatest first marks
  the thread (namespace `agboss-out-of-order`), and a marked thread is read by LangGraph's step.
  An unmarked thread costs one more look per latest read. No API change.

- **An action ran without a fence after its `onActionStart`** (#662, found in the acceptance of
  #640): #640 checks the holder's fence right before an automatic undo's action; an ordinary action
  visit — the undo action a side path runs (`.onError(DeclinedError, toAction(RefundAction))`) and
  any forward step — awaited `onActionStart` (masked first, a model call with `detectWithModel`)
  and then ran with no check. Held there past its lease, its tree taken over and the action run by
  the new holder, the old holder ran it again: a refund (or a charge) paid twice when its effect is
  not fenced. Every action now checks its holder's fence right before `execute`, nothing awaited in
  between; a holder past its lease hands over.

- **A booking stopped by the budget at its refund was never refunded** (#675, a follow-up of
  #656): a main-path refund that is also a booking's undo, held back by the exhausted budget, with
  its own `.onError(BudgetExceededError, …)`, closed the booking as a failed undo — nothing was
  refunded. The forward visit stays stopped; the booking it would have closed is now undone at once
  as an undo (its own key `<step key>:compensation`, past the budget, durable once like the
  automatic undo), before the side path goes on: `Compensated`, or `Failed` only with the undo's
  own error.

- **An undo's fence was checked before its observers, not before the undo action** (#640, found
  in the acceptance of #605): the holder checked its lease, then awaited `onCompensationStart` and
  `onActionStart` — each event masked first, a model call with `detectWithModel`, and observers
  awaited one after another — before it ran the undo action. Held there past its lease, its tree
  taken over and undone by the new holder, it ran the undo a second time: a refund paid twice. The
  fence is now checked again right before the undo action, nothing awaited in between; the first
  check stays, so a holder already past its lease reports no `onCompensationStart`. #605's own test
  did not bite (its old holder was stopped at a checkpoint renewal before the undo); the new cases
  hold the old holder at the read of its undo's done mark, in `onCompensationStart` and in
  `onActionStart`, for a root's, a failed join's and a child's undo, and each check bites.

- **A failed join's undo ran again after a takeover** (#607): its undos wrote no done mark, so the
  instance that recovered the tree — from the checkpoint before the failure became durable — undid
  the booking a second time, a refund paid twice. Each undo of a failed join is now marked done
  (`@agboss/compensated/<key>`) before the next one starts and before the join's update or error is
  written; a recovering instance skips what is marked, and the join's update closes it so a side
  path's finish never commits it. Every automatic undo — a join's, a root's (failed, cancelled, out
  of budget), a child's on either placement, a recursion level's — is now proven to run to effect
  once across one and two takeovers.

- **The gate can no longer pass without the fault suite** (#630) — one run of `make check` ran 587
  files and not one of `tests/faults/`: vitest 3's forks pool skips a `singleFork` project whole when
  another fork of the pool rejects, and a test that held its fork 60 s with a synchronous child
  process made the fork's report to vitest time out. `npm run coverage` now holds vitest's JSON
  report against `packages/agboss/test-run.json` (`scripts/check-test-run.mjs`): every file of
  `unit` and `faults` ran a test, each at least its `minFiles`, else it fails naming the project and
  the files. The core's tests await their child processes (ESLint refuses `spawnSync`,
  `execFileSync` and `execSync` there). No API change.

- **An undo runs only while its holder holds the tree** (#605, found in the acceptance of #596 /
  #597) — a holder frozen right before its failed step's error reached the checkpointer, whose tree
  another instance took over and undid, ran the undo a second time when it thawed (a child's, or a
  root's own): its expiry timer had not fired yet, and nothing checked the lease before the undo
  action. Each undo action now runs only after the holder's own fence (`assertHeld`, #533): a holder
  past its lease hands over at the undo (`HandOverSite.Compensation`) and undoes nothing.

- **The linearizability checker places each operation inside its own span** (#617, found in the
  acceptance of #533) — it took an operation at the latest instant of an earlier one, past its own
  completion: a take of a live lease at 10 ms passed behind a frozen holder's renewal that answered
  at 40 s. An operation now takes effect within its span; the instants tried are the span's ends and
  just before and at each lease expiry inside it; one nobody saw answer may land any time after its
  invoke (a store applies a request whose caller is gone), so a take that landed after the expiry
  no longer fails a sound history.

- **An explorer case aborted while it shrinks a violation makes no store call after** (#618, found
  in the acceptance of #590) — the cutting down of a found schedule replayed it again and again,
  each replay resetting the store, after vitest had timed the case out and moved on. The cutting
  down, each replay and each walk now stop with the case's signal and time limit; the case still
  fails, with the schedule as found and why it was not shrunk.

- **The key-text cases catch an accent-insensitive collation** (#620, found in the acceptance of
  #533) — a store whose business-key column compares accent-blind (MySQL's `_ai_ci`, an ICU
  strength-1 collation, a unique index on `unaccent(key)`) and keeps each key as first given passed
  every case of `storeConformance`: "Zoë-17" found "Zoe-17"'s intent and replayed its payment. The
  round-trip keys now hold each one's accent-free twin ("café" and "cafe", "q̇" and "q", "straße"
  and "strasse"), each its own row.

- **A side path on a child's own error class is taken on every holder** (#598, found while fixing
  #596) — a child's failure that crossed a takeover (its claimed failure, #596; its undo's mark,
  #340) or an instance (an `AnyInstance` child's queue row) came back with its name and message
  only, so `.onError(PaymentDeclinedError, …)` matched on the instance that saw the failure and not
  on the one that took the tree over — a remote child's never. The failure's record (its class line
  by code, message and causes) is now kept there and rebuilt as a failure `.onError` routes as the
  original; a mark or a row written before this release routes as before, the same on every
  instance. A remote child's exhausted budget or failed undo now passes its parent's boundary as it
  is, as a local child's does.

- **A root's end is heard once** (#597, found in the acceptance of #562) — a root's holder that
  froze right after its tree's end became durable (its finish checkpoint, its failed step's error),
  whose tree another instance recovered and announced, announced the end again when it thawed, and
  its `app.execute` resolved with the output (or rejected with the tree's own error) as if it still
  held the tree. The end is now announced only while the pass holds the lease: the thawed holder
  stops at its own fence, rejects with `ExecutionLeaseLostError` and announces nothing.

- **An announced child failure stays the child's end** (#596, found in the acceptance of #562) — a
  `ParentInstance` child whose failure its parent's holder announced, the holder then frozen before
  its step was checkpointed, was run again by the instance that took the tree over: a step that
  now succeeded made the child heard failing and finishing and the root end instead of failing,
  and a child with an undo was heard failing twice. A child's failure is now claimed in the tree's
  store before it is announced (`@agboss/child-failure:<childExecutionId>`): one pass announces it,
  and a re-entry that finds the claim repeats it without running the step. A repeated failure keeps
  the error's name and message, not its class (as #340's unwinding mark): a side path on
  `ChildExecutionFailedError` / `StepFailedError` takes it again, one on the child's own error class
  by the cause chain does not.

- **Who calls is a key's text** (#589, found in the acceptance of #568) — an `ownerId` with a lone
  surrogate (`bob\uD800`, from `JSON.parse` of a token's `sub`) made `app.execute` on SQLite or
  PostgreSQL create a thread stored as `bob\uFFFD`'s, then refuse its own caller; the `bob\uFFFD`
  owner had the thread. `ownerId` at `execute`, `resume` and `cancel`, and a `Channel` pause's
  `answeredBy`, are now held to the key-text rules before anything is read or written:
  `dto.invalid` naming the field and the rule, never the id.

- **An empty fingerprint is not none** (#574, found by #533's mutation testing) — under a business
  key, a fenced effect with `fingerprint: ""` in flight on one instance beside one with no
  fingerprint was joined to it and got its result, though the pair made one after the other was
  `IdempotencyKeyConflictError`. Any text is a fingerprint, `""` too, and both orders are refused,
  in flight or stored; `fencedEffectContract` holds every store to keeping `""` as `""`.

- **The fault suite proves the payment's fence and refuses an opted-out set** (#584, found in the
  acceptance of #484) — no scenario let a zombie reach the outbound-call store after a takeover, so
  a store that recorded a payment's intent under any token passed all twenty; scenario 5c
  (`s05c-zombie-reaches-payment-first`) freezes a pod at its payment's intent while another takes
  the tree over and pays, and its stale write must be refused. And a set whose fenced-effect or
  outbound-call store declares `LeaseCheck.WithoutDoubleChargeProtection` passed the suite with no
  word of it: `faultSuite` now registers `fences atomically: no store declares
LeaseCheck.WithoutDoubleChargeProtection`, failing `[fault-suite.opted-out-store]`
  (`FaultSuiteOptedOutError`, naming the stores).

- **A child's end is heard once** (#562, found by #484) — a parent whose holder froze after its
  child ended, before its step was checkpointed, announced the child's `onExecutionEnd` (or
  `onExecutionError`), and the instance that took the tree over read the ended child again and
  announced it a second time (a third after a second takeover). An end is now announced only by the
  pass that ended the child, and only while that pass still holds the tree's lease: an
  `AnyInstance` child's finish by the worker whose completion of its queue row won, a cancelled one
  whose row went with its tree by the worker that stopped it, a child on its parent's instance by
  the parent's pass that ran it, a failure by the parent's pass that saw it happen (the undo runs
  there) — never by a parent that re-enters its step and only reads the end. The honest guarantee
  is at most once: a holder that freezes or crashes between the child's durable end and the
  announcement leaves it unannounced (Wiki → Guarantees-across-processes). The fault suite's
  `children-once` counts the observers' ends again — exactly one per finished child.

- **A minted thread id that never finds a free one is a typed error** (#613, found by #550's
  acceptance) — when the application's `IdGenerator` mints only ids the tenant already has (100
  tries), `execute` now fails with `DuplicateThreadIdError` (`run.duplicate-thread-id`: `generator`,
  `tries`, never an id) instead of a plain `Error` with no code, on every record store (PostgreSQL:
  agbossjs/postgres, the same error). `idGeneratorNameOf(generator)` (root entry) is the class a
  refusal names — the project's own, not the framework's check — for a store of your own.

- **A repeated execution id no longer joins another tree** (#591, found by #550) — an
  `IdGenerator` that repeats `newExecutionId()` (a sequential one restarted on a kept database, two
  tests on one file) gave a new root, child or recursion level the id of an older execution: one
  lease and fencing token, one lease log, one step key space — a fenced effect or an outbound call
  keyed by `<executionId>:<nodeId>:<visit>` replayed the other tree's stored result, and a finished
  tree's id could never take its lease. Every execution id the framework mints is now kept by the
  lease store before anything else of the execution is written (before its budgets' amounts, its
  thread, its lease, a child's marker): an id any execution had — of any tenant, running, paused,
  finished, failed or cancelled — is `DuplicateExecutionIdError` (`run.duplicate-execution-id`:
  `generator`, never the id), the root refused and a child's or a level's launch failed before it
  starts; of two instances minting one id at once, one runs. A resume or a recovery keeps its id and
  is not a create. A create that fails after its id was kept leaves the id taken, and nothing else.

- **An id the project's own `IdGenerator` mints is a key's text** (#578, found by #568) — the ids
  the framework mints (a root's, a child's or a recursion level's execution id, a new thread's id —
  at `execute`, a workflow run on its own and the eval runner) were never held to the key-text rules
  every id that comes in follows: a generator minting `x\uD800` and later `x\uDFFF` made two trees
  one lease, one lease log, one queue row and one fenced-effect scope on SQLite and PostgreSQL
  (both `x�` in UTF-8). Every minted id is now checked at the mint (`keyTextRuleOf`): one that
  breaks a rule (or is no string) is `InvalidMintedIdError` (`run.invalid-minted-id`: `generator`,
  `method`, `rule` — never the id), before it is used or stored. The built-in `RandomIdGenerator`
  and `SequentialIdGenerator` are unaffected; `app.resolve(IdGenerator)` gives the checked generator
  (`app.resolve(<its own class>)` the listed one).

- **A minted thread id is always a new thread** (#550, found by #533) — a store's `createThread`
  without a `threadId` handed out an id the tenant already had when its `IdGenerator` repeated one
  (two tests on one database both minting from `thread-1`): another workflow's thread, so the pass
  failed with `UnknownThreadError`, or another owner's thread of the same workflow, whose history the
  new execution joined. The core's stores mint the next id instead.

- **A tree whose undo a takeover finished keeps its undo actions** (#541, found by #484) — its kept
  record (`ExecutionHistoryRecord.compensations`, what `agboss records export` writes) listed none;
  it lists every undo action that ran, as its `onExecutionError` does.

- **A lone surrogate** (#530) is no business key or thread id (`InvalidBusinessKeyError`,
  `InvalidThreadIdError`): SQLite and PostgreSQL keep text as UTF-8, where two such keys were one
  row, and an outbound call's key threw `URIError`.

- **Keys with look-alike spaces are refused** (#547) — a business key and a thread id are refused
  when they hold a space other than U+0020 (Unicode `Zs`: U+00A0, U+1680, U+2000–U+200A, U+202F,
  U+205F, U+3000) or a line or paragraph separator (U+2028, U+2029) — `KeyTextRule.SpaceSeparator`,
  `space-separator` — and when a U+0020 starts or ends them or two come in a row —
  `KeyTextRule.Spacing`, `spacing`: `" order-1"`, `"order-1 "` and `"order  1"` were keys of their
  own beside `"order-1"` and `"order 1"`. The same entry points and messages as #538, the key never
  named. **Migration:** trim keys and thread ids, collapse runs of spaces and replace other spaces
  by U+0020 where they are made. A text that breaks several rules is named by the first in
  `KeyTextRule`'s order (`length`, `lone-surrogate`, `control-character`, `format-character`,
  `space-separator`, `spacing`, `not-nfc`), wherever each breach stands — the enum is declared in that
  order now (#547 acceptance).

- **Keys with invisible, private or unassigned characters are refused** (#556) — a business key, a
  thread id and a tenant id are refused when they hold a code point Unicode says renders as nothing
  (`Default_Ignorable_Code_Point`, whatever its category: the combining grapheme joiner U+034F, the
  Hangul fillers U+115F / U+1160 / U+3164 / U+FFA0, every variation selector — U+FE0E / U+FE0F too,
  so `"order:❤\uFE0F"` is refused —, the Mongolian free variation selectors and the property's reserved
  code points) — `KeyTextRule.Ignorable`, `ignorable` —; a private-use character or a noncharacter
  (U+FDD0–U+FDEF, U+xFFFE / U+xFFFF) — `private-or-noncharacter` —; a code point unassigned in the
  runtime's Unicode (`Cn`) — `unassigned`: a later Node may assign it a decomposition or make it a
  format character, refusing a key stored before; a code point never becomes unassigned again, so
  this rule never refuses a key it accepted (the categories the other rules read may change in a
  later Unicode — a refusal then, never a second charge, #587) — and U+2800 BRAILLE PATTERN BLANK — `blank`. The same entry points and
  messages, the key never named; in `KeyTextRule`'s order, after `spacing` and before `not-nfc`. During
  a rolling upgrade a key holding a character only the newer runtime's Unicode assigns is refused by
  an older instance — closed, nothing charged. **Migration:** drop variation selectors (an emoji
  without U+FE0F) and these characters where keys, thread ids and tenant ids are made.

- **A tenant id is a key's text too** (#552) — the rules of #538 hold a tenant id at
  `app.execute` (`tenant: { tenantId }`), `app.resume` and `app.cancel` (`dto.invalid`, the field
  and the rule named, never the id): a tenant id with a lone surrogate was written to SQLite and
  PostgreSQL as U+FFFD, so two tenants shared one thread, lease and business-key row, and its first
  execution failed with a raw `URIError` after binding the thread; an NFD or a zero-width tenant id
  was a second tenant of one customer. `app.cancel`'s thread id is checked as `execute`'s is
  (`InvalidThreadIdError`, the id kept out of the message and `onExecutionRejected`).
  So are the operator's reads (#568): `app.leaseEventsOf`, `app.outboundCallsOf` and
  `app.pendingOutboundCalls` refuse such a tenant id (`dto.invalid`) before the store is asked — on
  SQLite `t\uD800` read `t\uFFFD`'s pending charges and lease log —, and a trusted A2A request or MCP
  call under one is never deduplicated (its refusal was kept as the answer, under the merged key);
  its `onExecutionRejected` names the tenant `"default"`, as the event's documentation says, never
  the refused id. A tree's reads check its root execution id the same way (#580) (`dto.invalid` naming
  `rootExecutionId`: `r\uD800` read root `r\uFFFD`'s lease log), and `agboss records export
--tenant` and `agboss generate eval-case --tenant` refuse a tenant id that is no key's text (exit 2,
  `usage.option-value`, the rule named, never the id) instead of reading nothing.

- **Look-alike keys are refused, never charged twice** (#538) — a business key and a thread id
  are refused when they hold a C1 control (U+0080–U+009F, beside C0 and DEL), a format character
  (Unicode `Cf`: zero-width space and joiners — so emoji joined by U+200D too —, bidi controls,
  U+FEFF, the soft hyphen, tag characters) or are not NFC ("e" + U+0301; refused, never normalized
  silently, which would no longer replay a key stored before). `InvalidBusinessKeyError` and
  `InvalidThreadIdError` name the rule (`rule: KeyTextRule`, `keyTextRuleOf(text)` from the root),
  never the key; an invalid thread id is no longer echoed in `onExecutionRejected`. Checked by
  `effectKeyOf`, `OutboundCalls.send` and at every store's entry for a key built by hand
  (`checkedBusinessKey`, exported for a store of your own); new contract cases: keys of many scripts
  round-trip byte for byte and are each their own row, and a key built by hand breaking a rule is
  refused by every method. **Migration:** normalize a key where it is made (`text.normalize("NFC")`)
  and strip invisible characters from imported identifiers; `InvalidBusinessKeyErrorOptions` takes
  `rule` instead of `problem`.

- **A parent waiting for `AnyInstance` children is no longer taken over by another instance**
  (#516) — while it waited, the parent released its lease and only its own process knew the tree
  was live, so another instance's recovery sweep took the root over and the caller of a successful
  `execute` got `ExecutionLeaseLostError` or a "no longer queued" error. The yield is now visible in
  the store: `ExecutionLeaseRepository` gains `yield(lease)` / `reclaim(lease, duration)` (a yielded
  lease stays its holder's, is renewed, is refused to every other `acquire` until it expires, and is
  taken back at the next `token`). A holder that dies while waiting stops renewing, so its
  lease expires and the tree is recovered as before. **Breaking for a store of your own**: implement
  the two methods; `executionLeaseContract` checks them. The in-memory and SQLite stores implement
  them (SQLite adds the `yielded` column to an existing file).

- **A test that hangs fails fast** (#509): `testWith` bounds each app's close at the end of a test to
  10 s of real time — a run still frozen there (a step, a frozen lease, a wait on the
  `VirtualClock` nobody advances) fails the test with `AppCloseTimeoutError` (`test.close-timeout`,
  `@agboss/core/testing`) instead of hanging the run: vitest bounds no fixture's teardown.

- `checkpointSaverContract`'s `put` passes the changed channels' versions, as LangGraph does: a saver
  that writes values only for those versions (LangGraph's `PostgresSaver`) passes as it is (#511).

- **`workflowOf(W)` on the package installed from npm** — the application next to `W` was imported
  by Node, outside vitest (no decorators). A vitest preset, `agbossVitest()` from
  `@agboss/core/testing/vitest`, loads AGBoss and every file it loads by path through vite, in the
  test's module graph, and registers the matchers; `agboss create` writes it. Without it
  `workflowOf(W)` throws `TestSetupError` naming the fix. An existing project changes one line:
  `test: agbossVitest({ … })` in `vitest.config.ts` (the `setupFiles` entry may go). CI checks the
  packed packages in a project of their own (`npm run check:packed`) (#497).

- **A tree's kept record is saved before its cleanup** (#699) — the history record
  (`retention.executionRecords`) was saved after the tree's keys, its queued children and its pauses
  were removed, so a pod killed during that cleanup's round trips lost the record of a tree that had
  ended: nothing writes it later. The record is now saved first. Found by the fault suite's scenario
  12 on agbossjs/redis (a Redis child queue beside SQLite fencing).
  A tree ended without a pass (a paused tree cancelled, an unwinding takeover, a cancel request)
  keeps its record first too, pinned by a test (#787).

- **The explorer on a lease store alone** (#694) — a store set with a lease store and no
  outbound-call store (the coordination stores of Redis, `without` its fenced-effect and
  outbound-call stores) registered no `interleavings (<name>)` case at all: its leases were never
  explored. The world "every lease operation" now runs on the lease store alone — every schedule of
  two instances, seeded walks of three, every skew, no `leaseStateOf` step — with the two lease
  races (`retire` and `release` against another instance's take).

- **A child on any instance waits for its siblings' spend too — now pinned by a test, and the
  checkpoint write that waits for the pass's spend is mutation-tested** (#776) — the `settled()`
  before a child on any instance is queued (#732) covers spend a sibling branch tallies after the
  launching step's checkpoint, which the checkpoint gating does not: a test now holds a sibling's
  $60 write while a grandchild is about to be queued (without the wait it pays $50 twice beside it,
  $160 of $100). `SettledSpendCheckpointSaver` joins the `money` mutation shard.

- **A ledger write whose answer was lost is counted once by the pass's own checks too** (#770) —
  the write of a tallied spend (#727) that landed while its caller heard an error was held by the
  pass's next read of the counters while its tally still counted it: a check or a tally before the
  write was retried counted it twice, and a launch beside a step that paid $60 stopped with
  `BudgetExceededError` at "$146" for $86 spent of $100. A read now writes such spend again first,
  and fails when that write fails again.

- **A worker claims children on any instance up to its free step slots** (#767) — an instance with
  `maxConcurrentSteps` counted each `AnyInstance` child it ran twice while the child's step ran (its
  slot and its claim), so under a backlog it kept fewer children at work than it had slots. A claimed
  child now counts once — by the slot it holds, or as a claim while it holds none —, never more
  children than slots.

- **A spend that reaches a budget exactly exhausts it** (#728) — a float sum of costs lands a hair
  off its decimal value (eight $0.10 calls make 0.7999999999999999), so a $0.80 budget let a ninth
  step through. Spend and limit are compared in whole micro-dollars (rounded, no epsilon) before
  each step and model call, in the live tally, at a new execution's admission and for the
  application's spend outside an execution.

- **A model reply interpreter reads capped approvals** (#688) — on a cheap model "yes, up to $900" on
  a $1,200 call was read as not understood. For an approval role the answer tool names its decision
  (`approve` / `approve-with-changes` / `refuse`), the instructions say what a capped approval is in
  any language, and the answer's shape is checked, failing closed: an unknown decision,
  `approve-with-changes` without a correction, `approved` beside a decision or a correction that
  changes the call's shape (a new key at any depth, another kind of value, a list of another length)
  is not understood. A reply interpreter may change approved arguments within the call's DTO; put
  money limits in a guardrail or the action (a tool interceptor's `beforeToolCall` sees the corrected
  call before the tool runs).

- **The e-mail PII detector no longer takes a file extension into the address** (#729) —
  `anna@acme.com.pdf` was found as the address `anna@acme.com.pdf`, so its token, or the domain
  `replacePart({ keepDomain: true })` keeps, held the extension; `.mp4` cut the match inside the
  extension. The match drops its last label only when that label, with any letters or digits glued
  to it, is a common file extension that is no top-level domain (`.md`, `.zip`, `.py` are still read
  as domains) and what is left is a whole address; anything else is masked as before, so an address
  is never left unmasked (a property test holds it).

- **The linearizability checker follows a chain of expiries** (#750) — an acquire pinned by a
  renewal that the later answers pin inside its span was reported in a sound history (#660 tried one
  hop). Seeded histories the lease model answers itself (`linearizability-generated.test.ts`) are
  never reported.

- **The linearizability checker takes a renewal where the answers after it pin it** (#660, found in
  the acceptance of #617) — a renewal answered at 100 ms, then a take refused at 30 050 ms and the
  old token read as expired at 30 070 ms, is sound only with the renewal at 50–80 ms, which neither
  end of its span is: the checker failed it. An acquire, a renewal or a reclaim is now also tried
  where the expiry it sets meets another operation's span end.

- **Every dollar of a tree is counted once** (#685) — an `AnyInstance` child's spend was counted
  twice against the root's budgets ($60 spent refused as more): a counter read that overlapped a
  ledger write of the same pass, and a parent counting a remote child's spend from the ledger and
  from its own state. The meter's reads and writes now run one at a time, and a remote child's
  spend is taken in with a read of the counters before the parent's state shows it.

- **A child on any instance is never stuck behind a lease nobody runs** (#720) — a claim the store
  made whose answer was lost left the child `Running`; the reclaim kept its lease for the worker's
  next claim, and when that answer was lost too the lease was renewed for ever with nothing running
  and the tree never ended. A lease the reclaim's look did not start the child with now goes back.
  The child queue contract checks that a claim marks exactly the child it answers; the fault suite's
  `s16-claim-answer-lost` (`HoldRequest.loseAnswer`, `StoreAnswerLostError`) loses claim answers
  twice.

### Added

- **A2A skills that answer with a direct `Message`** (#860, epic #805) — an exported start declared
  `@A2AExpose({ skills: { [start]: { reply: A2AReply.Message } } })` (default `A2AReply.Task`)
  answers `SendMessage` with a `Message` and no task: its finish's output as text, data or file
  parts (#859), `returnImmediately` ignored, `SendStreamingMessage` one frame — the message — then the
  end, `GetTask` or a follow-up naming it `-32001`. Its workflow is stateless, checked at assembly on
  every node: no pause, no fenced effect, outbound call or A2A call through any service a node or a
  tool injects, only `@Tool({ readOnly: true })` tools and no `@McpTool`, no undo, no child workflow
  (`[a2a.message-skill-pause]`, `-effect`, `-tool`, `-compensation`, `-child`; a reply for no export
  or a `defaultSkill` that is none `[a2a.unknown-skill-option]`). `@A2AExpose({ defaultSkill })`
  runs a message that names no skill. The replies live in the new `A2ADirectMessageRepository`
  (`InMemoryA2ADirectMessageRepository`, the default; `SqliteA2ADirectMessageRepository`;
  `@agboss/postgres` and `@agboss/mongodb` ship theirs; `a2aDirectMessageContract`,
  `storeConformance({ stores: { a2aDirectMessage } })`), on the A2A task store's backend
  (`[a2a.message-store-not-shared]`): one `messageId` is one message across both reply modes — its
  id claimed among the task store's messages in the same atomic write, another message under it
  `-32602 a2a.message-id-reused`. A resend within `@Application({ retention: { a2aMessages } })`
  (default `minutes(15)`, above the lease) gets the same message, a concurrent duplicate waits for
  it — the model called and charged once; an attempt is bounded (its run aborted at 25 s and on the
  caller's disconnect, its row in flight 30 s), never continued by a recovery
  (`withoutRecovery`: an instance taking its lease over ends it as cancelled), and one lost — a
  crash — is taken over once by a resend or the sweep, which records one `CostSource.Unknown`
  entry (`unknown:a2a-msg:<tenantId>:<attemptId>`, counted in `agboss.instance.costs.unknown`) for a
  skill that can call a model and removes its files. The card publishes each skill's `reply` and
  the mesh extension's `messageIdempotencyRetention`; a trusted caller's reply carries the signed
  run report in `message.metadata[mesh-uri].report`. The client takes a `Message` answer without
  waiting for a task, settles its report, and trusts a resend to a direct-reply skill only within
  its `messageIdempotencyRetention` (15 min by default) — past it `OutboundCallUnreconciledError`;
  a message with no readable output is `A2ARemoteCallError` `no-task`. `@Tool({ readOnly })` is new.
  The official TCK's `DM-MSG-001` passes: 67 of 67 `MUST` requirements.
- **File parts in A2A messages and artifacts** (#859, epic #805) — a skill whose input DTO holds
  `A2AFileDto` fields (`@Nested(A2AFileDto)`, `@ListOf(A2AFileDto)`) takes `raw` and `url` file
  parts: each into the field its `metadata["https://agboss.dev/a2a/skills/v1"].field` names, else
  in order; never from a data part (`-32602 a2a.file-field-in-data`), and only at a DTO's top level
  (`[a2a.nested-file-field]`). Bounded by
  `@A2AExpose({ skills: { [id]: { files } } })` over `@Application({ a2aFiles })` (`maxFileSize`,
  `maxTotalFileSize`, `maxFiles`, `allowedMediaTypes`, `allowedFileOrigins`; 64 KB, 64 KB, 5, images
  / PDF / text / Markdown / CSV / JSON, none by default; `[a2a.file-options-invalid]`), each file's
  bytes checked against its media type (magic bytes, UTF-8; `-32602 a2a.media-type-mismatch`, a
  type not taken `-32005`), a file by url fetched once at the admission — `https:` on an allowed
  origin only, redirects by hand (≤ 3, each origin checked), never a private address, the read
  stopped past `maxFileSize`, bound to the request's end and `a2aHttpListener({ fileFetchTimeout })`
  (10 s) — and a resend never fetches again. A finish whose output holds files (`WorkflowFinishFileDto`,
  `WorkflowFinishFilesDto`, any DTO with file fields) answers with file parts in its artifact; steps
  read and make files with the `A2AFiles` service (`read`, `save`, `fromUrl`); the card lists the
  media types in `inputModes` / `outputModes`; `maxBodySize` grows with `maxTotalFileSize`. Files ride
  inline in the task's records with no store listed (`[a2a.inline-files-without-store]` above 64
  KB, `[a2a.file-store-required]` above 256 KB) or in an `A2AFileRepository`
  (`InMemoryA2AFileRepository`, `LocalDiskA2AFileRepository` on `a2aFilesPath`,
  `S3A2AFileRepository` — plain `fetch`, Signature Version 4, `a2aS3Bucket` / `a2aS3Region` /
  `a2aS3Endpoint?` / `a2aS3AccessKeyId` / `a2aS3SecretAccessKey`; `a2aFileContract`
  in `@agboss/core/testing/contracts`; `[a2a.file-store-not-shared]` for one host's store on shared
  leases), removed `retention.a2aFiles` (default `a2aTasks`, at most it) after the task is over —
  never while it waits. The client sends `A2AClientFile.fromBytes(…)` / `.fromUrl(…)`, reads file
  parts into the output DTO (a foreign agent's too), gives `A2ATaskResult.files` and
  `client.downloadFile(file)`. The official TCK's `DM-ART-001` file variants pass.
- **The AGBoss mesh over A2A v1.0, both sides** (#810, epic #805) — the A2A server checks a
  `SendMessage`'s envelope (`message.metadata["https://agboss.dev/a2a/mesh/v1"].envelope`) before
  the caller resolver and before anything runs: its audience first, against the application's own
  name (fail closed, mesh settings or not), then a known issuer's signature, replay window and the
  `bodyHash` of the message as decoded — `401 mesh.*`; a chain through the skill or past
  `maxMeshHops` is a `REJECTED` task with the limit's code and facts, which the client rebuilds into
  the same `MeshLoopDetectedError` / `HopsLimitExceededError`; a trusted caller's chain, origin,
  budget and deadline bind the remote execution, and its completed task carries the signed run
  report (`task.metadata[uri].report`, also on the stream's last status update). The card declares
  the mesh extension (`idempotencyRetention` = `retention.a2aTasks`) and echoes it. The client
  charges an A2A call's price and its report's excess on every pass under the call's own ledger
  identity (`UsageRecord.ledgerKey`, `LedgerKey`): a takeover that replays the accept charges them
  exactly once (price 1, report 3 → 3); a report must name the call's task; an agent that does not
  echo the extension is called without the mesh, said in the tool call's record (`remote: { …,
mesh: false }`) and in `agboss describe` (`a2a agents`, `mesh: not guaranteed`). An action's
  remote call passes its budget down too. `A2ATaskRecord.meshBodyHash` (SQLite: a column added on
  open), `A2ATaskStatus.errorDetails` / `spentUsd`, with `a2aTaskContract` cases.
- **A2A tasks shared by the instances, or no start** (#824) — `A2ATaskRepository` declares its
  backend (`static store = { backend }` since #825; the in-memory store `"in-memory"`, `SqliteA2ATaskRepository` `"sqlite"`;
  `PostgresA2ATaskRepository` in `@agboss/postgres` and `MongoA2ATaskRepository` in
  `@agboss/mongodb` share them on those databases). An application that serves A2A (`@A2AExpose`)
  on a lease store its instances share keeps its tasks where they share them too, else it does not
  assemble — `[a2a.task-store-not-shared]`, naming the store to list: on each instance's own
  memory a message resent to another instance would start a second execution. Redis keeps no A2A
  tasks. `ListTasks` answers `totalSize` — every task the filters match before paging, the same on
  every page — and `pageSize` the page size used; `statusTimestampAfter` filters in the store. The
  store contract gains `A2ATaskQuery.statusAtAfter` and `A2ATaskPage.totalSize`, with
  `a2aTaskContract` cases and sabotages.
- **Reranking for knowledge bases** (#703) — `@Rag({ rerank: { by, candidates, topK, onFailure } })`
  fetches `candidates`, a `@Reranker` re-orders them, and the agent gets the best `topK` (one name
  with `@Rag({ topK })`, #818), in tool and context mode. `by` is a `RerankerClass`: another class
  does not compile (#818). The core's LLM reranker (`@Reranker({ name, description, model? })` on a
  class that `extends ModelReranker`, default
  `openai/gpt-4.1-nano`) runs on the application's model providers — its cost in the turn's
  `retrieval` spend and every budget, its call traced (`rerank:<name>`), scripted in tests with
  `mockLlm(Reranker)`. A dedicated rerank API plugs in as `@Reranker({ decidedBy: DecidedBy.Code })`
  - `implements RerankerHandler` on its own SDK (`rerank(query, candidates, { topK, signal, tenantId
})` → `RerankResult`; `DecidedBy` and `RagSearchResultDto` come from `@agboss/core/rag` too). A reranker's result must be a subset of the
    tenant's candidates. On a failure: the retrieval's own order with a `rerank:<name>:fallback` span
    (default), or `RerankFailurePolicy.FailStep` → `RerankFailedError` (`step.rerank-failed`;
    `new RerankFailedError({ rag, reranker, cause, usage })`).
    `ragConnectorContract` takes `rerank` to run its cases through the reranking.

- **The races the store contracts were missing** (#695, found by `@agboss/mongodb`, #527) — the
  lease contract races two instances' `acquire` of one free lease (never leased, released,
  expired), round after round in both orders: exactly one is given it. A lease store that checks,
  then writes, passed every other case. The fenced-effect contract hands the lease over **while**
  its holder's write runs: the hand-over waits for the write, or the write is refused. A store
  whose lease check takes no lock (a read in a MongoDB transaction) passed the zombie's race of the
  same key. The record contract's compare-and-set race no longer asserts which of two instances'
  writes lands, only that exactly one does and the record holds it; nor does the paused-execution
  contract's race of two resolves of one pause (#704).

- **Fault scenario 12b** (#607) — `s12b-marked-undo-not-again`: a pod frozen right after it marked
  its undo done, before it failed the tree. The next pod takes the tree over and ends it without
  undoing again: the reservation is released once. `StoreHoldPoint.TreeSaveIfAbsent` holds a tree
  key's write by its family; `no-undo-on-hand-over` also fails a declined order released twice. A
  tree store that forgets the done marks fails 12b.

- **Fault scenario 5d** (#608, the gap #584 left) — `s05d-zombie-recorded-not-sent`: a pod frozen
  right after recording its payment's intent and before sending it, thawed after another pod took
  the tree over. The new holder reconciles the pending intent and pays once; the zombie is refused
  at its renewal before the send and hands over: one gateway request, one payment. A lease store
  whose renewal says yes to a lease that is over fails it on `effects-once` and `linearizable`.

- **Mutation testing of the fencing modules** (#533) — Stryker on the leases, the holder's fence,
  the held lease, the fenced effect, the outbound call's protocol and store, and the store's clock,
  in a CI job of its own: every mutant is killed by a test or justified at the code; the job fails
  below 100 %.

- **The interleaving explorer** (#533) — `storeConformance` now runs `interleavings (<name>)` on a
  set's fencing stores: a deterministic scheduler of simulated instances that take, renew, yield,
  reclaim, release and finish a tree's lease, ask `leaseStateOf`, write the step's fenced effect and
  move an outbound call through its protocol, one operation at a time — every schedule of two
  instances up to a depth (each state once), seeded walks of three, the second instance's clock off
  by ± lease/2, ± lease and ± 10 × lease while the store keeps the run's time — and every
  two-outcome race of the contracts forced in both orders (`retire` against a take, a release, a
  `leaseStateOf`, a write against its hand-over, each compare-and-set of an intent). After each step
  it checks one live holder, no write at a superseded, closed or expired token, one effect per key,
  one charge per business key and no takeover of finished work; a failure prints the minimal
  schedule. Its budget is
  `storeConformance({ interleavings: { depth, walks, walkDepth, seed, timeLimit } })`
  (`AGBOSS_EXPLORER_SEED`), `false` to leave it out. A search that runs out of `timeLimit` (default
  8 min) or is aborted with its case stops and fails with what it explored — schedules, states and
  how many it left — never a pass, and never goes on resetting the store under later cases (#590).
  Wiki → Your-own-store.

- **The linearizability checker** (#533) — every fault run's store history is checked against the
  sequential model of the fencing stores (`faultViolationsOf` → `linearizable`): one order of the
  recorded operations, each at an instant of its span on the store's time, in which every answer is
  the model's; an operation nobody saw answer may or may not have taken effect. A part with none is
  reported with the longest order found and what could not follow it. `linearizabilityOf(history,
{ timeScale })` (`@agboss/core/testing/faults`) checks any history; the store set says
  what its stores decide by (`FaultStoreSet.storeTime`, #799: a database's own clock is read at 1). The history
  now keeps a lease's length, a claim's expected state and an ending's owner.

- **The fault suite** (#484) — `@agboss/core/testing/faults`, a published entry of its own (never
  loaded by the root): `faultSuite({ name, storesModule, database: { url, reset }, timeScale? })` runs
  the fixture application in real `node` processes on one database — SIGTERM, SIGKILL, SIGSTOP /
  SIGCONT, the database cut by a TCP proxy per pod — and checks after each of its 20 scenarios (#533:
  two of a pod whose clock is ten leases ahead or behind)
  that each tree had one owner at a time, every child and every charge happened once, a hand-over
  undid nothing and every tree finished (`FaultInvariantError`, each invariant named). Store hold
  points for any store (`withHoldPoints(Store)`, `StoreHoldPoint`) force the order of operations
  across processes, and the run's history (`OperationHistory`) keeps every store operation's
  invoke and complete. The core runs it on SQLite; Wiki → Guarantees-across-processes.

- **Business idempotency keys** (#508) — `effectKeyOf(executionContext, name, { businessKey,
fingerprint? })`: one fenced effect or outbound call per tenant, name and business key, whatever
  step, execution or thread makes it; another fingerprint is `IdempotencyKeyConflictError`; a
  business key shows only by its keyed handle. A pending call under a business key is in flight
  while the lease that wrote it is live (`OutboundCallRepository.leaseStateOf`, an expired lease
  closed by the check in one atomic step); a holder waits for its attempts within
  `@Application({ outboundCalls: { attemptTimeout } })` (default `minutes(2)`, from the attempt's
  start) — a send still hung past this bound can coincide with a reconcile and a resend; the provider must deduplicate on `call.idempotencyKey` (G1). `OutboundCallResultNotStoredError`, `OutboundCallSupersededError` (#795) and the
  `outbound-call.*` log codes; no read shows a fingerprint.

- **Handover telemetry: the lease log** (#501) — a takeover of a tree's lease is told and kept:
  `onExecutionLeaseTakeover` (`ExecutionLeaseTakeoverEvent`: the new holder and token, the expired
  holder when the store names it — `ExecutionLease.takenOverFrom`, optional for an external store —,
  `LeaseTakeoverReason`, the head checkpoint) and a `Takeover` row of the new infrastructure contract
  `ExecutionLeaseEventRepository` (in-memory default, `SqliteExecutionLeaseEventRepository`, the
  published `executionLeaseEventContract`), always written, read with `app.leaseEventsOf({ tenantId,
rootExecutionId })` and removed by the recovery sweep after `@Application({ retention: { leaseEvents } })`
  (default `hours(24)`). A step handed over (a lost lease, a fenced write, the app's stop) is told
  and kept too: `onStepHandedOver` (`StepHandedOverEvent`, `HandOverReason`, `HandOverSite`) and a
  `HandedOver` row, once per error at the innermost site, written before the moving call rejects;
  a kept `ExecutionHistoryRecord` carries its tree's rows as `leaseEvents` (and so does
  `agboss records export`). Every call of a fenced effect from a step is told and kept as well:
  `onFencedEffect` (`FencedEffectEvent`, `FencedEffectEventOutcome`: ran, replayed, joined,
  refused — never the result) and a `FencedEffect` row, so the public log alone tells a zombie
  refused at its write from one that never reached it, and a replay from a new write.
  `FencedEffectAsyncWorkError` moved to the SQLite store's module (still exported from the root).

- **A store outside the core on the public surface alone** (#511, found by `@agboss/postgres`):
  `@Injectable({ environmentFields })` + `EnvironmentField` — a class declares the environment fields
  it reads, checked at assembly for every listed class and every class its `deps` reach
  (`[environment.missing-field]`, `[environment.conflicting-field]`; `SqliteConnection` declares
  `sqlitePath` so); `VirtualClock.track(work)` and `{ settleTimeout }` — `advance` waits for tracked
  work (`UnsettledWorkError`), and the published contract suites track every store call of their
  targets; every type an infrastructure contract names is exported by the root entry (`Tern`,
  `NewTern`, `TernOutcome`, `Summary`, `NewSummary`, `ConfigSnapshot`, `VersionScore`,
  `ExecutionData`, `CostReport`, `Usd`, …), a test enforces it.

- **Tag-triggered releases** (#691) — `.github/workflows/release.yml` publishes `@agboss/core`
  then `@agboss/cli` with npm provenance on a pushed tag `vX.Y.Z`, only when CI passed on that exact
  commit; agbossjs/postgres publishes `@agboss/postgres` on `postgres-vX.Y.Z` on the core from npm.
  `RELEASE_CHECKLIST.md` is the maintainer's ordered runbook.

- **Question roles: a workflow asks a typed question and goes on with the typed answer** (#659) —
  `@ChannelRole({ ask, answer, answeredBy })` (a name ending with `-question`, optional
  `replyInterpreter` and `maxVisits`) is back (#647 had removed the form, nothing could ask it), and a
  flow step asks it: `.returns(AskDto).toQuestion(Role).returns(AnswerDto)` (`question(Role)` for
  its own path). The step pauses like any pause — `result.pending` (`kind: PauseKind.Question`,
  the masked ask), `answeredBy`, the pause records and their retention, `result.record.pauses` —
  and the answer goes on the path: `app.resume({ pauseId, decision })` validated as `AnswerDto`,
  `{ reply }` read by the role's `@ReplyInterpreter` into it (not understood → the pause stays
  pending), or the channel's `ChannelOutcome.decided(answer)` at once. Exactly one answer wins,
  another instance continues it, a cancel withdraws it. `ChannelRoles` types `ask` / `answer`,
  `agboss describe` prints where each question is asked. A failed `send` is `QuestionFailedError`
  (`step.question`). `PendingPause` is now a union on `kind` (`PendingApproval` |
  `PendingQuestion`); a pause record's `ask` is a `PauseAsk`.

- **An agent asks a question role as a tool** (#712) — `@Agent({ tools: [SpendingLimitQuestion] })`:
  the model calls the role (input = its `ask`), the loop pauses on the role's channel before the
  move's other tools run, and the typed `answer` (a decision, an interpreted reply or the channel's
  `decided(…)`) is the call's result, PII-masked; every guarantee of a question step holds, the
  role's `maxVisits` bounds one visit's calls, budgets and the fence are checked before each ask.
  `callTool(Role, ask)` scripts it; an approval role in `tools` is `[channel.approval-role-as-tool]`.

- **A child queued in another process wakes the claimers at once** (#777) — the optional
  `ChildExecutionQueueRepository.watchQueued(onQueued)` (`ChildExecutionQueueWatch`): a store that
  can be woken (PostgreSQL `LISTEN` / `NOTIFY`, a MongoDB change stream) has every instance with a
  free step slot claim a child another instance queued as soon as it is queued, instead of at its
  next sweep (every 30 s). A hint only: a wake-up lost is claimed at the sweep; a watch that does not
  open is warned (`child-queue.watch-failed`) and opened again at the next sweep. The contract suite
  checks a store's watch when it has one.

- **`testReplyInterpreter(Role, { model })`** (#644) — a role's `@ReplyInterpreter` on its own:
  `{ ask, reply }` in, `{ isUnderstood: true, answer }` or `{ isUnderstood: false, reason }` out, as
  `app.resume({ pauseId, reply })` reads it; a code one through its container, a model one on its
  script.

- **DX papercuts** (#644): `[application.pii-instance-key]` only when something makes a PII token (a
  policy, a `sensitive` field — a text start's optional `sender` is one); `[application.in-memory-pauses]` names the store left in memory; an
  OpenAI-compatible provider without `requestFields` is `[model-provider.request-fields-missing]` at
  assembly; a unit runner's `environment` takes only the fields the unit reads, and the SQLite
  error says how to pass `sqlitePath`; a cancelled launch branch keeps no raw `AbortError`.

- **`[limits.max-steps-below-worst-case]`** (#643) — `agboss check` warns (an error under `--strict`)
  when a hand-set `maxSteps` is below the worst case of a flow whose every loop `maxVisits` bounds:
  the run would fail with `StepsLimitExceededError` before the loop's own
  `.onError(VisitsLimitExceededError, …)` ends it. The message names the loop and the `maxSteps` that fits.

- **`PauseAnswerRecord.asked`** (#688) — the call as asked (an approval's tool and its own arguments,
  before any correction a reply made) or a question's ask, masked like `decision`: beside the call as
  it ran, every change a reply made is auditable. Absent on a record kept before.

- **The business-key identity and the outbound call's runtime are mutation-tested** (#626) — the
  `keys-and-calls` Stryker shard joins `fencing` and `sqlite-stores`, cold every night, failing below
  100 %. Wiki → Guarantees states each shard's counts from the cold run of `0ed7fb7e` (406, 857 and
  271 mutants; every one killed, timed out or justified where it stands).

- **Takeover, recovery, undo and the budgets' money are mutation-tested** (#633) — five Stryker
  shards join the three: `takeover` (the lease's yields, attempts and takes, the hand-over),
  `recovery` (the sweep, a root taken over, a tree's end and moves), `undo` and `unwind` (each
  automatic undo, its entries, marks and registry; a step's, a child's, a failed join's and the
  root's unwind) and `money` (the budget meter, the application's spend, the cost ledgers), cold
  every night, failing below 100 %. Wiki → Guarantees states each shard's counts.

- **Autoscaling metrics through OpenTelemetry** (#485) — `createApp(App, { meterProvider })`
  publishes the instance's metrics on a meter the application gives (none given → nothing loaded,
  no store read): cluster gauges read once from the shared child queue
  (`agboss.cluster.children.queued` / `.running` / `.oldest_queued_seconds`, the same on every
  instance), per-instance step slots, waiting steps and held leases, and counters of takeovers,
  hand-overs, ended executions and compensations, with bounded labels. Names, kinds, units and
  labels: Wiki → Metrics; one source feeds Prometheus / KEDA, CloudWatch, Cloud Monitoring and Azure
  Monitor through the standard exporters.

- **Projects created by `agboss create` come ready for graphify** (#480) — a `.graphifyignore`, a
  `.graphifyrc` and a git-ignored `graphify-out/`; the project's `AGENTS.md` and the agboss skill
  ask the code graph first when there is one. `create` says in one line how to enable it; it never
  runs graphify.

### Fixed — other

- **`agboss rag index` is atomic per tenant and stops on Ctrl+C; the terminal answers questions
  in an explicit mode** (#891, API review G11): `SqliteFtsConnector.index()` reads every document
  first and writes every change in one transaction — an interrupted run (an abort, an unreadable
  document) leaves the tenant's index as it found it, never a partial one the first retrieval would
  take as built; SIGINT / SIGTERM abort the signal `agboss rag index` indexes under (`rag.interrupted`,
  exit 1; was a signal that never aborted). A question pause's answer in the terminal is the typed
  answer only on a line starting with `{` — which must be JSON, else it is asked again — and a
  free-text reply otherwise (`42`, `["a"]` too), as the prompt says; the request is built typed (no
  cast). `--tenant`'s help reads "without it: the tenant "default""; `agboss migrate`'s summary
  names `@agboss/core`; `agboss create`'s `tests/services/api.service.test.ts` runs on
  `testWith(<Project>Application)`.

- **`agboss rag index` without `--tenant` built the `default` tenant's index in a multi-tenant
  application** (#797) — and reported success, while the tenant meant stayed unbuilt; `records
export` already refused the same omission. In an application that declares a tenant context
  (`@Application({ tenantContext })`) the bare command is now exit 2, `rag.tenant-required`,
  nothing built; name the tenant with `--tenant <id>`. An application without one still builds
  `default`, its only tenant. `agboss help rag` and the CLI's README say so (the help said "default:
  default").

- **An agent with only an answer tool answers with one call** (#649) — OpenAI models call tools in
  parallel by default, and gpt-4.1-nano answered with three `answer-…` calls in one move: every
  attempt was refused and the step failed. An agent whose only tools are its answer tools (not a
  list of variants, which may answer with several) now sends `parallel_tool_calls: false` to
  OpenAI-compatible servers. A move that still holds several answer calls is one answer when they
  repeat it exactly, and refused — never one picked — when they differ: the model reads why, and the
  step's `AgentAnswerInvalidError` names "N different answers in one move".

- **No "Sourcemap … points to missing source files" under `agbossVitest()`** (#645) — `@agboss/core`
  and `@agboss/cli` ship their `src/` beside `dist/`, so the source maps vite reads once the core is
  inlined find their TypeScript: a new project's `npm test` printed ~700 such lines, and a stack
  trace inside the core named files that did not exist; now it names lines of the installed
  package. `npm run check:packed` fails when a shipped map names a source the tarball lacks, when
  the probe project's test run prints the warning, or when a failure inside the core names a frame
  the package does not have.

- **The store-backend hint names no function** (#554) — a backend named like an object's own
  member (`"constructor"`, `"toString"`) made the hint of `[application.store-backend-mismatch]` print
  `(function Object() { [native code] })` as the core store to list; it is now a name with no core
  store, like `"postgres:billing"`.

- **`circuitBreakerPolicy: null`** (#529) is a missing policy: `[model-provider.circuit-breaker-required]`
  at assembly and in `agboss check`, never a `TypeError` in `createApp`.

- **`check:installs` and `check:real-time`** (#531) miss no common form: `npm install-test`, a line
  continued with `\`, every `--package=`, `["i", …]` and `"npm install …"` in scripts; a duration
  through a second variable, a limit named by a constant.

- **No test asserts real elapsed time against a fixed number** (#523, after #509): the model
  call and Jev timeout tests run on a `VirtualClock`; `npm run check:real-time` (in `make check`)
  fails on a new real-time threshold.

- **The packages keep their commands on npm 12** (#691) — `bin` is `bin/agboss.js`, not
  `./bin/agboss.js`, which npm 12's publish rejects; found by the release workflow's dry run.

- **A question role's pause is stored and read back on SQLite** (#746) — `SqlitePausedExecutionRepository`
  read every pause's `ask` as an approval's tool call (`callId`, `tool`, `arguments`, `summary`),
  so a question asked by a flow step (#659) or by an agent's tool (#712) on the SQLite stores failed
  its execution reading its own pause back. A question's ask is kept as written, told apart by the
  pause's `component.kind`. `pausedExecutionContract` gains the case (a question's pause found,
  sent, answered and taken on the other instance as written), which a store that reads only an
  approval's ask fails — as `@agboss/postgres` and `@agboss/mongodb` did.

- **No store is called before the components started** (#747) — `createApp` wrote each workflow's
  config snapshot (the config-drift warning) through the record store before any component's
  `onInit`, so a store readied there failed first: on a fresh PostgreSQL `createApp` died on
  `relation "agboss_config_versions" does not exist` instead of `PostgresSchemaMissingError`, and
  `postgresMigrateOnStart` could never migrate. The snapshot is now written after every `onInit` →
  `onStart`; its warning is still in `app.warnings` and the start log.

- **An application that calls no model no longer needs the OpenRouter key** (#716) — `createApp`
  read the key of every model provider at start, so an application of actions only failed without
  `openRouterApiKey`. A provider is now connected at start only when a model of the workflow
  resolves to it (or it is that provider's breaker fallback); another connects on its first call.
  An application that uses a model still fails at start without its key, naming the field.

- **`testWith` gives the application's PII key field the test key** (#778) — a fixed test key
  covered a PII policy's own `pseudonymKey`, but `@Application({ pseudonymKey: "piiPseudonymKey" })`
  with `piiPseudonymKey: secret("PII_PSEUDONYM_KEY")` in the test environment failed as a missing
  variable, so every project set `PII_PSEUDONYM_KEY` in its vitest `env`. The field's variable now
  gets the test key when the test process does not set it (a test that sets it keeps its value);
  `createApp` and the CLI still refuse to start without the real key.

- **`agboss check --strict` reports every analyser warning as an error** (#769) — it kept only
  three codes of a hand-written list, so `[limits.max-steps-below-worst-case]` (#643),
  `[limits.child-concurrency-above-parent]` and `[flow.committer-unreachable]` printed under a plain
  `agboss check` and vanished under `--strict`, which exited 0. The analyser's own warnings are now
  the errors `--strict` reports; there is no list to fall behind.

- **`callTools(…)` is an agent's typed turn; a scripted call names a tool the agent lists** (#679) —
  two calls in one move needed a cast with generated types. `.agboss/types.d.ts` now has
  `AgentTools`, the tools each agent may call, and brands each tool class with its name, so a
  `callTool` / `callTools` turn of a tool the agent does not list does not compile.
  `ToolCallTurn` / `ToolCallsTurn` take the tool's name as a type parameter.

- **`agboss studio` loads a project under a symlink** (#666, #671) — the generated
  `.agboss/studio.ts` imported the application by a path computed between the paths as given, and
  the module loader resolves a relative import from the importer's real path, so a project or
  `.agboss/` under a symlinked folder (macOS's `/var` → `/private/var`, a linked checkout) loaded
  nothing. The specifier is now computed between the real paths of both.

- **`@agboss/core/testing/faults` is imported from the build outside vitest** (#721), and three
  tests that flaked under load are fixed (#717 flow-patterns' coverage run, #722 the knowledge
  base's tenant isolation, #762 the store's-time authority cases judge only timed attempts).

### Docs

- **The guarantees page** (#533) — Wiki → Guarantees: the five guarantees of several instances
  (one owner per tree, one effect per business key, one send per attempt, no takeover of finished
  work, compensation only on real failure), the eleven assumptions they rest on with what breaks
  when one does not hold, every proof with where it bites, and what no checker reaches.

- **The READMEs and the agboss skill stated the budget's overrun bound narrow** (#686, after
  #664): the root README, the package README and the skill's FinOps reference now state the same
  bound as CLAUDE.md — the calls in flight, plus the steps it never holds back, plus, across
  instances, other trees' steps before the spend is in the ledger.

- **Wiki → Guarantees says what each proof bounds** (#625, found in the acceptance of #533) — a
  stepped database clock can make two instances trust one lease (A3); the explorer covers P2 for the
  step's key only, up to its depth and over its listed races; on PostgreSQL it explores the SQL on
  the test's clock, and database time is proved by agbossjs/postgres' clock tests; the mutation row
  names its scope and its over-broad comments; P5 rests on store conformance, with its proofs.

- **Running on PostgreSQL** (#482) — the README and Wiki → Running-on-PostgreSQL: installing
  `@agboss/postgres` (released with the core, its version), wiring its 13 stores, migrations, the
  one-backend check of the fencing stores, connection limits, what the guarantees assume of the
  database (`clock_timestamp()`, one slewed clock) and how the stores are proved
  (`storeConformance`, `faultSuite`).

- **The idle scale-in signal does not see a root that waits for the recovery sweep** (#751): a
  root handed over by a graceful stop (or left by a crash) is on no gauge until another instance's
  sweep takes it, so idle can read true for up to one sweep. Wiki → Metrics and Autoscaling say so,
  and keep `minReplicaCount ≥ 1` (`tests/metrics/hand-over-window.test.ts`).

- **Wiki → Running-on-PostgreSQL's wiring compiles; Several-instances links the gateway notice**
  (#749) — _Wire the stores_ imported `days` from `@agboss/core/units`, which exports `seconds`,
  `minutes` and `hours` only (`retention: { executionRecords: hours(24 * 30) }` now; agbossjs/postgres's
  README the same); Several-instances names Adyen and Stripe (`keyRetention`, #658) and now links
  the notice, as #686 asked of every page naming a gateway.

- **A fenced effect's `work` may run more than once per call** (#730) — `FencedEffectWork`,
  `saveResultIfAbsent` and CLAUDE.md now say what `@agboss/mongodb` documents: a store may run
  `work` again within one call (MongoDB re-runs an aborted transaction), keeping the last attempt's
  writes, so `work` writes only through its transaction and calls no other system.

- **The README lists all 14 examples of agbossjs/agboss-examples** (#420).

## [0.1.0] — 2026-10-26

The first substantive release of the framework, published to npm on 2026-10-26. Everything below is new compared with the `0.0.1` placeholder;
the Wiki's Changelog lists the breaking changes made between pull requests on the way.

### Added

- **Applications and dependency injection** — `@Application` with its workflows, infrastructure,
  budgets, defaults and environment contract; one container per application instance with
  constructor injection (`deps`), lifecycle hooks and `createApp(App)` → `app.execute` / `resume` /
  `cancel` / `close` (#261).
- **The flow as paths** — `@Workflow({ flow })` with `start(…)`, `.returns(…)`, `.toAgent` /
  `.toRouter` / `.toAction` / `.toFinish`, `.chooseOne`, `.switch(caseOf(…))`, `.onError`, typed by
  the generated `.agboss/types.d.ts`, every assembly rule reported at once before any model call
  (#272, #270, #299); outdated values tracked on the path scope (#271).
- **Components** — `@Agent` (its own tool loop), `@Router` decided by a model or by code (#280),
  `@Action`, `@Tool`, `@WorkflowStart` / `@WorkflowFinish`, DTO classes (`@agboss/core/dto`) for every
  value that crosses a boundary.
- **Parallel work** — parallel launches and joins (#273), quorums with arbiters (#279), child
  workflows (#263), recursion with `ThisWorkflow` and `maxDepth`, the tree's and the instance's
  concurrency caps (#264, #332).
- **Pauses and approvals** — channel roles, durable pauses answered by id, free-text replies read by
  reply interpreters, pause answer records (#267).
- **Declared compensation** — `compensateWith` / `committedBy`, checked at assembly, and the
  automatic undo of a failed join or a failed execution, finished by recovery (#339, #340).
- **Several instances** — the execution lease with fencing, recovery of interrupted executions, the
  graceful stop, SQLite implementations of every store, health checks (`app.checkLiveness()` /
  `app.checkReadiness()`) (#265, #335, #360, #367, #300). Execution history (#401): with
  `@Application({ executionRecordRetention })` every root execution's record — with its identity,
  masked like its traces — is kept in the new `ExecutionHistoryRepository` (in memory or
  `SqliteExecutionHistoryRepository`) and swept after it; `agboss records export` writes it as JSON
  Lines.
- **Models and FinOps** — model providers as infrastructure (OpenRouter and the Decisions API built
  in) with retry, rate-limit and circuit-breaker policies; `@Budget`s per execution, tenant and
  application; cost accounting of every model call (#266, #261, #338).
- **Safety and quality** — PII policies masked at the model boundary, input and output guardrails
  decided by a model or by code, judges on an agent's answer as its DTO, memory compaction with
  built-in or custom strategies (#120, #262, #382, #383).
- **Testing** — `testWith(App)` with scripted models, the virtual clock, deterministic ids, class
  matchers, recorded runs and unit runners for every component kind (#262, #313); tool-call
  trajectories on results, records and `JudgeInput`, and one record per step (#395).
- **Eval suites** — `@EvalSuite` (`@agboss/core/eval`) with typed cases, trajectory checks and code or
  model judges under a declared cascade; `agboss eval run --suite <name> --runs <k> --report
<run.json>` runs each case k times on the application and reports pass@k / pass^k per case, the
  unstable ones flagged, into a run artifact (`agboss.eval-run`); `agboss check` assembles the suites;
  `--baseline <run.json> --fail-on-regression` compares each case with a run of `main` and exits 5
  (`quality`, `eval.regressed`) when a stable case regressed — a case flaky there is quarantined
  (#396). `--html <file>` and `agboss eval show <run.json> --html <file>` render a run as one
  self-contained HTML page — summary, unstable cases, attempt dots and every run's checks (#397);
  the artifact (`schemaVersion` 2) keeps each run's trajectory, masked, and the page shows it as a
  timeline, with the baseline diff and the node where an unstable case's attempts part ways;
  `agboss eval ui` serves a folder of runs on 127.0.0.1 behind a token, where people label a judge's
  verdicts into `eval/labels/<suite>.jsonl` and see κ recomputed, and save a run's kept execution
  (on its thread, of its tenant — each run's `tenantId`, `schemaVersion` 4) as a golden case of its suite — written into the suite's file, refused on a duplicate name or a
  file changed since the page was made (#397).
  `agboss eval calibrate --report <run.json>` reads a run's judges against people's labels
  (`eval/labels/<suite>.jsonl`) — Cohen's κ per labeler and between labelers, the confusion and the
  disagreements by the judge's metrics (#396).
  `agboss compare` judges each pair in both orders (a flip is a tie, `positionFlips`), and a
  judge of its agent's own model family warns `[judge.same-model-family]` (#396). Breaking on the
  way: `compareProfiles(Workflow, …)` is `compareProfiles(Application, { start, … })`.
  `agboss eval run --chaos <rate> --chaos-seed <n>` injects 429s, timeouts and truncated answers
  into the run's model calls (`ChaosFailure`; `eval run` only, never a `createApp` option) (#396).
  `agboss eval run --metamorphic` runs each case's `variants` (its last turn reworded) and checks
  they call the same tools with the same required calls — the check `metamorphic` (#396).
  `agboss generate eval-case <name> --from-execution <executionId>` drafts a case from a kept
  execution (#401's history) into its suite — the turn, the contexts, the thread's earlier turns,
  the calls it ran as `tools.required` — masked as kept, nothing run (#396).
  `agboss hub show <path…> [--html <file>]` reads many applications' describe snapshots, eval runs
  and exported executions into one mesh — the applications, the calls between them, each one's
  health from its files — and one self-contained page; no project, nothing runs (#401).
  Its page shows each execution tree that crosses applications, stitched from their exports by each
  receiver's `origin` (the calling execution and its call's idempotency key) — a receiver that
  exported nothing is a stub (#401).
  Its crystallization radar ranks the mesh's model steps by spend × stability — how often one
  input gets one decision — and names the candidates to turn into code; each step record gains its
  `decision` (`route:` / `launch:` / `variant:` / `answer:<hash>`) for it (#401).
  `agboss hub ui <path…>` serves the Hub on 127.0.0.1 behind a token — `eval ui`'s own server and
  rules, read-only — with a search of the kept executions and a JSON API (#401).
  Both draw each contract the snapshots declare as an edge consumer → producer, and list the
  problems `agboss check --federation` finds between them — the same check — with their blast
  radius, and who calls an application whose latest eval run lost pass^k (#401).
- **The CLI** (`@agboss/cli`) — `agboss create`, `agboss generate`, `agboss check`,
  `agboss describe`, `agboss dev`, `agboss studio`, `agboss chat` / `agboss run`, evaluations and
  comparisons (#268). Breaking on the way (#396): the bare `agboss eval` is now `agboss eval score`
  (`agboss eval` lists its subcommands `run` / `score` and exits 2).
- **Skills for coding agents** — `SKILL.md` and thirteen references shipped in the package and synced
  into a project by `agboss check` (#305), among them a step-by-step guide to migrating LangGraph
  code — state, edges, `Send`, `interrupt` — to AGBoss (#424).

## [0.0.1] - 2026-10-10

### Added

- A placeholder published to npm to reserve the `@agboss/core` and `@agboss/cli` names; it holds no framework code.

[Unreleased]: https://github.com/agbossjs/agboss/commits/main
[0.0.1]: https://www.npmjs.com/package/@agboss/core/v/0.0.1
