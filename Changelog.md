# Changelog

Breaking changes and notable additions, newest first. The API reports
(`packages/agboss/api/*.api.md`) hold the exact public surface of each entry.

## Unreleased — concurrency, instances and unit runners (#262, PR 3)

- **Parallel branches in tests** ([Testing → Parallel branches](Testing#parallel-branches--testconcurrency)):
  `testWith(App, { concurrency })` — **`TestConcurrency.Sequential`, the new default**: the branches
  of a launch run one at a time, in listed / item order; `TestConcurrency.Real` runs them as
  production does (within `maxConcurrency`); `TestConcurrency.inOrder([step(A), step(B, partial)])`
  makes them complete in that order through completion gates (`step(Node, partial?)` takes the
  matcher of `when(…)`). A step waiting at its gate is cancelled at once by a `FailFast`, a decided
  quorum or `app.cancel`; when no branch can move and the next step is not waiting, the execution
  fails at once with `test.unreachable-step`; a listed step never reached fails the test at its
  end. **Breaking for tests:** a test that relied on branches running at once (a sliding window, a
  surplus answer, an agent waiting for its siblings) sets `concurrency: TestConcurrency.Real`.
- **Unit runners** ([Testing → Unit runners](Testing#unit-runners--one-component-on-its-own)):
  `testTool`, `testAction`, `testRouter`, `testArbiter`, `testRag`, `testJudge`, `testGuardrail`
  and `testPii` — one component on its own container (`overrides: [override(Class,
  Replacement)]`, `environment`), every call in its step's frame (`executionContext.signal` with a
  `timeout` on the runner's `VirtualClock`, `run.clock`; `SpendRecorder` and its model calls into
  `spend`), its model by script (`model: decideWith(…)`, `replyWith(…)`, `routeTo(…)`); a call gives
  `{ output, spend }` and rejects as the component threw. `testPii([Policies])` checks the
  policies' own rules first (`-pii-policy`) and gives `mask(text)` / `reveal(text)`. The
  `agboss create` / `agboss generate tool` / `agboss generate openapi` tool tests use `testTool`.
- **`testWith(App, { instances: 2 })`** is the documented way to test across instances: one store
  set, one clock, a container each — a lease, a pause resumed on the other instance, a rate-limit
  slot ([Several instances](Several-instances#testing-several-instances)).
- **`testWith(App, { overrides: [override(Class, Replacement)] })`** (#267 S104): a class replaced
  by a class in the application's container, over any listed one — a channel role answered by
  `override(RefundApprovalRole, AutoApproveChannel)` (the replacement's `send` must fit the role).
  `AutoApproveChannel` / `AutoRejectChannel`'s `send` now gives `DecidedOutcome<AutoDecision>`
  (`approved`, `reason`), so they fit any role that approves a tool.
- `GuardrailContext` is exported from `agboss` (the context `testGuardrail`'s hooks take).
- New page [The test split](Test-split): unit tests with scripts → evaluation and golden sets →
  `make smoke`; no test calls a real model.

## Unreleased — recursion and the soft stop (#264, PR 1)

- **`ThisWorkflow`** ([Workflow as a step → Recursion](Workflow-as-a-step#recursion-264)): a workflow
  launches itself — `.toWorkflow(ThisWorkflow)`, `route(ThisWorkflow)`, `.toParallelWorkflows(ThisWorkflow,
  …)`; the node `this-workflow`, run from the registry (Studio: `recursive: maxDepth N`).
- **`@Workflow({ maxDepth })`** required on a recursive workflow (`[graph.recursion-without-depth]`);
  the root is depth 1, `ChildExecutionRecord.depth` and each child's trace metadata carry it.
- **The soft stop** on the last level: an agent's recursive variants leave its schema, a model
  router's recursive routes are hidden, a code router returning one is `RouterDecisionError`; every
  such branch keeps an exit (`[graph.recursion-without-exit]`).
- **`DepthLimitExceededError`** (`limit.depth`; `workflow`, `maxDepth`, `depth`): a launch by code
  past `maxDepth` does not start; the level above gets it as the `cause` of `ChildExecutionFailedError`.
- **`[graph.mutual-recursion]`**: mutual recursion, a flow naming its own class, a class undefined
  while the flow is built. **`[types.this-workflow-outputs]`**: recursive workflows of one project
  with different finish classes.
- `agboss describe`: the `recursive:` line, per-item child results counted (`this-workflow ×0–5`);
  the worst case counts the levels down to `maxDepth`.

## Unreleased — child workflows at run time (#263, PR 2)

- **Children run** ([Workflow as a step](Workflow-as-a-step#at-run-time)): `flow.child-not-runnable`
  is removed. A child is a node of its parent whose subgraph is the child's compiled graph (Studio
  draws it inside), on the parent's checkpoint thread under its task's `checkpoint_ns`; its own
  `executionId`, kept in its state across a pause, a restart and a crash (no second
  `onExecutionStart`); its own path, steps and `maxSteps`; no thread history; the parent's thread,
  `ownerId`, tenant and execution fields inherited; the root's budgets spent (a child workflow's own
  execution budget applies only as a root). A child need not be listed in
  `@Application({ workflows })`: collected transitively, it goes through every application rule a
  listed one does (names, models, DI and infrastructure, channel roles), budget coverage aside.
- **PII tokens** (#120): a child starts with its parent's tokens and gives its own back — with its
  value, or with its error (into the parent's state, never on the error) to the side path that
  takes it, a per-item child's too.
- **`ChildExecutionFailedError`** (`step.child`, a `StepFailedError`: `cause`, `childExecutionId`,
  `itemIndex`, `workflow`): an uncaught error of the child, its own `maxSteps` / `maxVisits`
  included; budgets and cancellation pass through unwrapped (S25). `PaidStepError` stays the base of
  `StepFailedError` (`step.failed`, #273 S71).
- **`toWorkflow(W)` side-path starter** (S85): `.onError(E, toWorkflow(W)…)`, also in `.onJoinError`.
- **Records**: `result.children` / `result.record.children` (`ChildExecutionRecord`,
  `ChildExecutionStatus`), `result.handledErrors` (`HandledErrorRecord`); observer events carry
  `parentExecutionId` / `rootExecutionId`; `executionContext.parent`, `root`, `depth`, `itemIndex`,
  `executionOf(W)` read the tree; `ExecutionTreeRepository` keys are the root's.
- **Pauses inside a child** (#267): the root's — in `result.pending` with `childExecutionId` and, per
  item, `itemIndex`; several children may wait at once; resumed by `pauseId` like any other.
- **Testing**: `toHaveChildExecutions(W, [...])`, `toHaveHandledError(E, { at, by })`.
- **The worst case** of a start counts its child executions (`maxItems` × the child's, at most
  `maxConcurrency` at once) and their depth.
- **Example**: `examples/flow-patterns/src/vendor/` — a child workflow per vendor.

## Unreleased — pauses and resume (#267, PR 2)

- **Several pauses at once** ([Pauses](Pauses)): a paused branch of a parallel launch does not stop
  its siblings; the execution rests when nothing else can move. **Breaking:**
  `ExecutionOutput.pause` → **`pending: readonly PendingPause[]`** (`pauseId?`, `answeredBy`,
  `agent`, `channel`, `itemIndex`, `childExecutionId`, `ask` — the `ToolCallApprovalAskDto`),
  empty unless paused; `ExecutionPauseEvent.pause` → `pending`, fired only when the execution
  rests (again after a partial resume).
- **Breaking — resume by pause id:** `app.resume(threadId, decision, { tenantId, ownerId })` →
  **`app.resume({ pauseId, decision }, { tenantId, ownerId | answeredBy })`** (`ResumeRequest`,
  `ResumeOptions = ThreadOwnerResumeOptions | ChannelResumeOptions`). The pause is found by
  `(tenantId, pauseId)` anywhere in the tree; unknown or another tenant's → **`UnknownPauseError`**
  (`pause.unknown`); with others left the execution pauses again with the rest. A
  `PauseAnswerer.ThreadOwner` pause lists its id and takes `ownerId`; a `PauseAnswerer.Channel` pause
  takes a non-empty `answeredBy` (recorded on the pause and in `onExecutionResume`, new field
  `answeredBy`) and its id is only in the channel's `ask.pauseId`; the other credential →
  **`PauseAnswererError`** (`pause.wrong-answerer`). A concrete `@Channel` named as is answers as the
  thread's owner. The CLI, the MCP `resume_workflow` tool (`{ pauseId, decision }`) and the A2A
  adapter (`resume({ pauseId, decision })`, `POST /resume { pauseId, decision }`, the response's
  `pauseIds`) follow.
- **Breaking — `ToolCallApprovalDecisionDto`** is `{ approved, reason?, overrideArguments? }`: `by`
  is gone (who answered comes from the resume), `feedback` → `reason`; `overrideArguments` only
  with `approved: true` and a valid input of the tool — on `resume` (the pause keeps waiting) and on
  `ChannelOutcome.decided(…)` (the step fails).
- **Breaking for your own `PausedExecutionRepository`** (#267 S35): `PausedRun` keeps the run and
  its versions only; each pause is a `PauseRecord` of its own, keyed by its step's idempotency key —
  `findOrCreateByStepKey`, `findByTenantIdAndPauseId`, `findAllByTenantIdAndRootExecutionId`,
  `markSentByTenantIdAndPauseId`, `resolveByTenantIdAndPauseId` (atomic `Pending → Resolved`),
  `cancelByTenantIdAndPauseId`, `markTakenByTenantIdAndPauseId`, `deleteByTenantIdAndPauseId`;
  `resolveByTenantIdAndThreadId` is removed. `PauseStatus` gains `Taken` and `Cancelled`.
  `SqlitePausedExecutionRepository` adds a `pauses` table and drops the old `status` / `decision`
  columns of `paused_executions` (a pause written before cannot be answered by id).
- **Concurrent answers** (Q58): one `Command({ resume })` per pass maps every answered pause;
  the holder drains decisions recorded meanwhile; a double click → `NotPausedError`; a reply that
  lands while `send` is returning is taken at once. **`FailFast` withdraws paused siblings'
  pauses** (`Cancelled`; a late answer → `NotPausedError`); so does `app.cancel` and the end of a
  tree. The join after a withdrawal gets the branch's own error object (`.onJoinError(E, …)` by
  class and cause chain); a channel's `send` that throws fails the agent's step (`AgentFailedError`,
  the channel's error as `cause`).
- **Spend while several loops are paused**: the execution's spend and the ledger hold every
  paused loop's spend, summed, each once; a resume records nothing twice.
- `resumeAgent(paused, resume, deps)` (internal wiring) takes the tree's answers (`TreeResume`)
  instead of one decision.

## Unreleased — scripts and matchers (#262, PR 2)

- **`when(…)`** on `mockLlm(X)` ([Testing](Testing#binding-turns-to-the-input--when)): turns bound to
  the node's input values, `PartialValues<InputOf<X>>` — values only, `undefined` for an absent
  field, lists by length and position, `variant(XDto, { … })` for a `oneOf` element (`variant` takes
  a partial value there). A call no script matches fails naming its input (`test.no-matching-script`).
- **Scripts are expectations**: a `thenReturn` turn no call took, a `when(…)` nothing matched or a
  scripted tool failure never caused fails a test whose body passed (`test.unused-script`;
  `thenReturnAlways` never does). **Breaking for tests** that scripted turns their run never reaches:
  drop them, or use `thenReturnAlways`.
- **Typed scripts**: `replyWith(XDto, fields)` must be a class of the agent's output and
  `routeTo(...targets)` follow `Route<R>` — one target after `.chooseOne(…)`, the `OnDemand`
  targets (or none, with an `Always` route) before `.toParallelAgents(…)`, which `routeTo(…)` now
  scripts too. The generated `RouterAnswers` has an entry for every router, model routers included.
- **`waitFor(duration)`**: the next turn answers only after that long on the test's clock.
- **A caller's own thread id** ([App](App)): `app.execute(Start, input, { threadId })` with an id
  the tenant does not have yet creates that thread — keyed by `tenantId` + `threadId` (the same id
  in another tenant is another thread), bound to `ownerId`, created only once the budgets pass.
  Before, it was `UnknownThreadError`; that stays for `cancel` of an unknown thread. A bad id
  (empty, over 200 characters, a control character) is the new `InvalidThreadIdError`
  (`run.invalid-thread-id`). **Breaking for your own `ExecutionRecordRepository`:**
  `createThread({ workflow, tenantId, ownerId?, threadId? }: NewThread)` takes one object and
  returns the thread's id; every read by thread names both values — `lastTerns(tenantId, threadId,
  limit)`, `uncovered(tenantId, threadId)`, `before(tenantId, threadId, ternId, limit)`,
  `turnNumber(tenantId, threadId, ternId)`, `latestSummaries(tenantId, threadId, limit)`,
  `summaryCount(tenantId, threadId)`; a `Summary` and a `MemoryTurn` carry `tenantId` next to
  `threadId`. The SQLite thread store's migration 11 keys threads by `(tenant_id, id)`
  (owners, Terns and summaries by `(tenant_id, thread_id)`); existing threads are `default`'s and
  keep their ids.
- **`mockAction(A)`** (the action still runs) and **`mockTool(T).thenFail(ToolFailure.Timeout)`**;
  the call matchers **`toHaveBeenCalledWith`**, **`toHaveBeenCalledTimes`**, **`toHaveReturned`** on
  `mockLlm(X)` / `mockAction(A)` (Vitest's own on anything else) and `mockLlm(X).inputs`.
- **Breaking — `toFailWith(ErrorClass, { …fields, cause })`** replaces `toFailWith({ code, node })`
  (`ExpectedFailure` removed): `toFailWith({ code: "step.action" })` →
  `toFailWith(ActionFailedError)`, `{ node: MainRouter }` → `toFailWith(RouterFailedError, {
  nodeId: nameOf(MainRouter) })`, a budget by its name → `toFailWith(BudgetExceededError, { budget:
  { name: "tenant-daily-budget" } })`. The root `ErrorClass` takes the error's type
  (`ErrorClass<TError>`).
## Unreleased — optional environment variables (#266 S87, S90)

- **`env.optional("X")`**, `env.integer.optional("X")`, `env.flag.optional("X")` — a variable that
  may be unset: typed `T | undefined`, unset → `undefined` (not a missing variable), a set value
  still checked; `agboss check --env` marks it `(optional)` ([Environments](Environments#the-environments)).
  New public type `EnvironmentValueReader<T>`; `EnvironmentVariableReader` extends it.
- **The base-URL field repeats no default**: `openRouterBaseUrl: env.optional("OPENROUTER_BASE_URL")`
  — unset → the decorator's `baseUrl` ([Model providers](Model-providers)); job-scout and
  `agboss create` declare it this way.

## Unreleased — PII policies and the model boundary (#120, PR 1)

- **`@PiiPolicy` is rebuilt** ([Guards → PII policies](Guards#pii-policies)): declarative
  `{ name, description, rules: [pii(PiiKind | PiiGroup, PiiAction.…)], detectWithModel?, pseudonymKey?:
  secret("…") }`, or a project's own detector `{ name, action, deps }` + `implements
  PiiPolicyHandler` (`findMatches(text)` → `PiiMatch { start, end }`). **Breaking:** the
  `PiiPolicy` interface (`mask` / `maskJson`) is removed; names end with `-pii-policy`.
- **Actions** `PiiAction.replaceWithKind()`, `replacePart({ keep… } | { pattern })`,
  `replaceWithToken()` (HMAC-SHA256), `blockWithRefusal({ refusal } | ())` + `PiiRefusal`;
  `PiiRefusedError` (`pii.refused`), `PiiDetectionFailedError` (`pii.detection-failed`).
- **Levels**: `@Application({ piiPolicies })` (new) → `@Workflow` → `@Agent` / `@Router`; the lists
  add up, `excludePiiPolicies` removes. **Breaking:** `overridePiiPolicies` / `disablePiiPolicies`
  are removed, and so are the PII policies of `@Tool` (a tool sees real values; its agent's
  policies close its result). Assembly rules `[pii.conflicting-rules]`, `[pii.exclude-not-inherited]`,
  `[pii.missing-refusal]`, `[pii.unused-refusal]`, `[pii.kind-needs-model]`, `[pii.not-a-policy]`.
- **The model boundary** masks everything a model reads and reveals its moves before validation;
  the token map is the execution state's `piiTokens` channel (S38, replaces #121's store).
- **Observability**: events, the log, Langfuse spans and `result.record` are masked by the
  application's and the workflow's lists ([Observability](Observability#pii-in-events-logs-traces-and-the-record));
  **breaking:** `onPiiPolicyStart` / `onPiiPolicyEnd`, `OnPiiPolicyStart` / `OnPiiPolicyEnd`,
  `PiiPolicyStartEvent` / `PiiPolicyEndEvent` and `PiiPolicyPayload` are removed — an observer that
  implements one of the hooks fails assembly with `[observer.unknown-hook]`; delete the method
  (there is nothing to migrate to: masking happens at the model boundary, not in a hook).
- **Breaking — `sensitive: true | { kind }`** is replaced by `sensitive: PiiAction.…` (masking
  actions) on DTO and context fields; `WorkflowStartTextDto.author` is `replaceWithToken()`; a channel
  shows such a field through its action instead of `***`.
- **`@Application({ pseudonymKey: "piiPseudonymKey" })`** names a `Secret` field of the environment
  ([Environments](Environments#the-pii-key)): the HMAC key of `sensitive` fields, project detectors and
  every policy without its own key (now optional) — one token per value on every instance. A
  policy's own key wins; a policy that needs the application's when none is set fails the start; a
  field the contract lacks is `[environment.missing-field]`.

## Unreleased — channel roles and discovery (#267, PR 1)

- **Channels are found through the tools that name them** ([Tools → Approval channels](Tools#approval-channels)):
  **breaking — `@Workflow({ channelClasses })` is removed**; one channel instance per application.
- **`@ChannelRole`** — a project's abstract class (`extends ChannelOf<Self>`) with `approves: XDto`
  or `ask` / `answer`, a required `answeredBy: PauseAnswerer.ThreadOwner | PauseAnswerer.Channel`
  and an optional `replyInterpreter`; its one implementation (`@Channel`, `extends` the role) is
  listed in `@Application({ providers })`. New assembly codes: `[channel.wrong-tool]`,
  `[channel.shared-interpreter]`, `[channel.role-form]`, `[di.missing-implementation]`,
  `[di.ambiguous-implementation]`; a `@Channel` in a workflow's `providers` is
  `[di.infrastructure-in-workflow]`.
- **Breaking — the channel contract**: one method, `send(ask: ChannelAsk<Role>): Promise<ChannelOutcome<Role>>`
  (`ask = { pauseId, value }`, typed by the generated `ChannelRoles`), returning
  `ChannelOutcome.awaitReply()` (pause) or `ChannelOutcome.decided(decision)` (no pause).
  `requestApproval`, `ChannelRequest` and `ChannelDecision` are removed.
- **Breaking — `InboundChannelAdapter` and `SemanticInboundChannelAdapter` are removed** (and
  `@Channel({ inboundAdapter })`): `app.resume(threadId, decision)` takes the
  `ToolCallApprovalDecisionDto` itself until free-text replies come with #267 PR 3.
- `AutoApproveChannel` / `AutoRejectChannel` now decide at once (`decided`) — no pause.

## Unreleased — rate limits and retries, provider keys in the environment (#266, PR 2)

- **`rateLimitPolicy`** on `@ModelProvider` ([Model providers](Model-providers#ratelimitpolicy)):
  `RateLimitPolicy.of({ maxConcurrentCalls?, perMinute?: { calls?, tokens? }, balancing? })` — one
  limit for the whole application, every execution, tenant and instance, its state in
  `RateLimitRepository`. A call without room waits (its signal ends the wait — `app.cancel` with `ExecutionCancelledError`; the attempt's `timeout`
  starts with the room); waiting tenants share free slots by `QueueBalancingStrategy`
  (`TenantRoundRobin` default, `TenantLeastInFlight`, `TenantWeighted` by `tenant.weight`, `Fifo`); a
  429 pauses the provider's whole queue for `Retry-After` (else the retry delay) on every instance,
  then halves the instance's concurrency, back by one a minute (AIMD). No policy → no limit.
- **`retryPolicy`** is the only backoff; a wait between attempts holds no slot.
- **`RateLimitRepository`** gets windows and pauses: `addToWindow`, `clearWindow`, `pauseUntil`,
  `pausedUntil` — abstract, so **breaking for your own implementation** (in memory and
  `SqliteRateLimitRepository` implement them; a SQLite file gets two new tables on open)
  ([Several instances](Several-instances#a-model-providers-rate-limit-across-instances-266)).
- **Breaking — the circuit breaker's state** is in `RateLimitRepository` (an open breaker holds on
  every instance) and on the application's `Clock`: `CircuitBreaker` takes
  `(provider, policy, { rateLimits, clock })` and its methods are async; `CircuitBreakers` and the
  process-wide breakers are removed.
- **Breaking — provider keys are `Secret`s of the environment**: `apiKey` names the field
  (`apiKey: "openRouterApiKey"`), set with `openRouterApiKey: secret("OPENROUTER_API_KEY")`;
  a base URL may come from a text field too (`baseUrlField: "openRouterBaseUrl"`,
  `env.optional("OPENROUTER_BASE_URL")` since S90). **`EnvironmentVariable`**, `MissingEnvironmentVariableError`,
  `SettingValue`, `OPENROUTER_API_KEY` and `OPENROUTER_BASE_URL_SETTING` are removed — `env()` /
  `secret()` are the one way to read a process variable ([Environments](Environments#secrets)).
- **`agboss check` without `--models` needs no secret values** (it reads the contract's shape);
  `--models` connects and fails on a missing secret, naming its variable.
- **Breaking — provider names end with `-model-provider`** (`[name.kind-suffix]`): the built-ins are
  `openrouter-model-provider` and `decisions-model-provider` (in `describe`, the startup log and
  model problems).

## Unreleased — quorums at run time (#279, PR 2)

- **Quorums run** ([Parallel → At run time](Parallel#at-run-time)): decided in the launch's
  superstep as answers arrive — each branch's arbiter chain in its slot and frame, the answer
  recorded at once (`BranchVerdict.Counted` with `acceptedSequence`, `Rejected` with `rejectedBy`,
  `Surplus`), the rest cancelled once the quorum is fixed; the join decides from the records (counted
  answers in counting order, the winning group's own path). `flow.quorum-not-runnable` is removed.
- **New errors**: `QuorumNotReachedError` (`step.quorum`) and `ArbiterError` (`step.arbiter`), both
  `StepFailedError`s, taken by `.onJoinError(E, …)`; `QuorumShortfall`.
- **Deadline** on the application's `Clock`: `deadlineAt` at dispatch, kept in the launch's ticket; a
  pause counts. After a resume or a crash the quorum is rebuilt from the finished branches' records;
  an expired deadline cancels the rest without running it.
- **Under a quorum** a branch's own step failure is `Skipped` (its place stays empty) whatever the
  route's failure policy; an `ArbiterError` or a limit fails the launch.
- **Model arbiters**: one decision per answer under `arbiter:<name>` (`answer-arbiter` on a chat
  model), budgets checked before each call; their prompts and criteria in the prompt version, their
  model a model use (`arbiters.<name>`). Code arbiters are created by the container at start.
- **Shown**: `LaunchRecord.isQuorumReached`, `LaunchRecord.group` (`QuorumGroupRecord`),
  `BranchRecord.verdict` / `acceptedSequence` / `rejectedBy`; trace entries; the hook
  `onQuorumDecided` (`OnQuorumDecided`, `QuorumDecidedEvent` — a node event, `step` the launching step).
- **Testing**: `mockLlm(ModelArbiter).thenReturn(decideWith({ counts: 0.9 }))`.
- **CLI**: `agboss generate arbiter <name> --workflow … [--agent …]` — a code arbiter with one
  `@OnAnswer` method per agent of a launch.

## Unreleased — logging, observers, describe (#261, PR 6; #269)

- **Breaking: observers are registered only in `@Application({ observers })`**
  ([Observability](Observability)); `@Workflow({ observers })` is removed (does not compile). One
  manager per application instance, for every execution of every workflow.
- **Breaking: hooks are named after executions** — `onExecutionStart`, `onExecutionEnd`,
  `onExecutionPause`, `onExecutionResume`, `onExecutionError`, `onExecutionRejected` replace
  `onWorkflowStart` / `End` / `Pause` / `Resume`, `onError` and `onRunRejected` (interfaces
  `OnExecution…`; events `ExecutionStartEvent`, `ExecutionEndEvent` — `finish`, `spend`, once per
  execution at a finish — `ExecutionPauseEvent`, `ExecutionResumeEvent`, `ExecutionErrorEvent`,
  `ExecutionRejectedEvent`).
- **Breaking: one event object per hook, no `AppState`** (removed): every execution event extends
  `ExecutionEvent` (`executionId`, `parentExecutionId`, `rootExecutionId`, `threadId`, `tenantId`,
  `workflow`); node events extend `NodeEvent` and add `step` (`StepRecord`). `ValuesOutdatedEvent`
  and `LaunchItemsTruncatedEvent` gain `tenantId`.
- **Breaking (#269): `ExecutionOperation.Execute | Resume | Cancel`** in
  `ExecutionRejectedEvent.operation` replaces the strings; the event carries `tenantId`.
- **Breaking: the untyped `executionContext` / `metadata` execute options are removed**, with
  `ChannelRequest.metadata` / `.executionContext`, `GuardrailContext.metadata` / `.executionContext`
  (no longer generic) and `RunContext.metadata`: components read the typed contexts through an
  injected `ExecutionContext`; `McpService.connect(transport, session?)` / `handleSse(res, endpoint,
  session?)` take `McpSessionOptions` (`tenant`, `execution`, `ownerId`); `A2ACallOptions` is
  `signal`, `ownerId`, `tenant`, `execution`.
- **New: the `Logger` contract** (infrastructure; `ConsoleLogger` by default, `LogLevel`,
  `LogEntry`, `formatLogEntry`) replaces `process.emitWarning` (`execution.recovered`,
  `recovery.incompatible`, `recovery.failed`, `app.close-failed`, `observer.failed`); in tests an
  unlisted logger is silent. `ExecutionObserverManager`'s default failure listener no longer warns.
- **Breaking: renames to executions** — `WorkflowObserver` → `ExecutionObserver`,
  `ObserverManager` → `ExecutionObserverManager`, `WorkflowCancelledError` →
  `ExecutionCancelledError` (code `workflow.cancelled` → `execution.cancelled`); `agboss migrate
  imports` rewrites the imports.
- **New: `nameOf(C)`** — the `name` of any AGBoss-decorated class (its literal type where the
  generated types brand it), for filtering serialized events and records.
- **New: the start log** — what started and the worst case of one call of each start; no
  `maxSpend()` at start, nothing per tenant; `testWith` logs none of it.
- **New: assembly warnings** `[application.in-memory-cost-ledger]`, `[application.in-memory-pauses]`
  — in `app.warnings` and the start log, errors under `agboss check --strict`; `agboss check` runs a
  new `application` check. The CLI's `run` / `chat` no longer print `app.warnings` themselves (the
  start log has them).
- **New in `agboss describe`**: the application — each contract's implementation and why, budgets
  by scope with their periods, the workflow's execution budget, observers, warnings — and a
  `limits` section (`maxSteps` set or default, `maxVisits`, worst cases); `--json` adds
  `application` and a richer `limits`.
- flow-patterns lists `SqliteCostLedgerRepository` (environment `sqlitePath`) so its strict check
  passes.

## Unreleased — quorums in the grammar and the analyser (#279, PR 1)

- **New: quorums** ([Parallel](Parallel)): after `.toParallelAgents(…)`,
  `.joinQuorum({ min, max, deadline })` (options always an object; `max` defaults to `min`) and
  `.joinQuorumGroups(group(A, B).priority(n).returns(…).to…(…), …, { deadline })` — every group
  continues its own path, nothing follows the groups but `.onJoinError(…)`. New builder names:
  `group`, `anyOf`; types `Quorums`, `QuorumJoined`, `GroupsJoined`, `GroupStart`, `GroupValues`,
  `GroupPath`, `GroupHead`, `AgentsLaunched`, `QuorumOptions`, `QuorumGroupsOptions`,
  `AnyOfArbiters`, `ArbiterChoice`; AST `QuorumKind`, `CountQuorum`, `GroupsQuorum`, `Quorum`,
  `QuorumGroup`, `AcceptedBy`, `ArbiterClass` (`LaunchStep.acceptedBy`, `JoinStep.quorum`).
- **New: `@Arbiter` and `@OnAnswer(Agent)`**, attached with `.acceptedBy(X)` (a chain is an AND,
  `anyOf(X, Y)` the first that accepts, S57): by model (`criteria` per agent) or by code (one
  method per agent class, typed by the decorator). New `agboss/units`: `hours()`.
- **What `.returns(…)` may promise**: after `.joinQuorum({ min })` with `min` below the agents
  launched a single answer is `optional(XDto)` (compile error and `[flow.quorum-return-not-optional]`
  otherwise); a repeated class or a shared `output` is `listOf(XDto)` in every form; a group's
  agents are required in its `.returns(…)` (`JoinOutputs["<launch> group(<agents>)"]`).
- **New rules**: `[flow.quorum-impossible]`, `[flow.quorum-return-not-optional]`,
  `[arbiter.not-an-arbiter]`, `[arbiter.unhandled-agent]`, `[arbiter.unknown-agent]`,
  `[arbiter.duplicate-agent]`, `[arbiter.answer-method-on-model]`, `[arbiter.method-name]`;
  `[input.missing-on-path]` names the agent a quorum may leave out and the fix.
- `agboss describe` prints quorums and counts a quorum list's producers (`critic-agent ×1–2`).
- A workflow with a quorum did not assemble until #279 PR 2 (`flow.quorum-not-runnable`, removed there).
- `@QuorumRouter`, `QuorumStrategy`, `QuorumManager` and `.joinQuorum(n)` stay removed (AC11).
## Unreleased — budgets and limits at run time (#261, PR 5)

- **Budgets are checked** ([FinOps](FinOps#budgets)): every execution's budgets — its workflow's
  own execution budget (else the default), every tenant budget, every application budget — have
  their `maxSpend()` read once, at its start, in its `ExecutionContext`, and kept in its state for
  the whole execution (a resume and a recovery count against the same amounts). Before the first
  step an exhausted one **rejects** the execution (`BudgetExceededError`, `onRunRejected`) leaving
  no trace — no thread (a new thread is now created after the check), no record, no call; every model call's cost is then counted in all of them, and before every step and model
  call the first exhausted stops the execution. Nothing is reserved (#202's holds are gone): a small
  overrun on a race, or by one call, is accepted.
- **New assembly rules**: `[budget.execution-budget-required]`, `[budget.duplicate-execution-budget]`,
  `[budget.duplicate-default-execution-budget]`, `[budget.tenant-budget-required]`,
  `[budget.application-budget-required]` — every application lists an execution budget for every
  workflow (own or the default), a tenant and an application budget.
- **Breaking — `settings().limits` is removed**: `WorkflowSettings.builder().limits(…)`,
  `WorkflowLimits`, `PerRunLimits`, `PerDayLimits`, `PerRunLimitRequiredError`
  (`[limits.per-run-required]`), `WorkflowSettingsError`, `LimitKey`, `SpendAccount` and
  `RunOptions.account` are gone; money is `@Budget`s only. `settings()` keeps `onIncompatibleResume`.
- **Breaking — the limit errors** ([FinOps](FinOps#steps-and-visits)): `StepsLimitExceededError`
  (`limit.steps`: `workflow`, `maxSteps`, `steps`; `support-workflow took 41 steps; its maxSteps is
  40`) for `maxSteps`; `BudgetExceededError` names its budget — `budget` (`{ name }`), `scope`, `key`
  (the application's name, the `tenantId`, the execution's id), `maxSpend`, `spent`, a sentence
  (`tenant acme spent $40.05 today; tenant-daily-budget allows $40`) — instead of the keys
  `limits.perRun.cost` / `limits.perDay.cost`. `toFailWith({ code })` matches a budget by its name.
- **Breaking — `CostLedgerRepository`** counts per budget, scope key and period:
  `findSpentByCounter(counter)`, `saveAll(counters, records)`, `findMaxSpendByAccount(account)`,
  `saveMaxSpend(account, maxSpend)` (new types `BudgetAccount`, `CostCounter`; were
  `findSpentToday(key)` / `saveAll(key, records)`). The ledgers read no time any more — the runtime
  names each counter's period from the application's `Clock` — so `InMemoryCostLedgerRepository()`
  and `SqliteCostLedgerRepository(connection)` take no clock. `SqliteCostLedgerRepository` drops the old
  per-workflow day table of a file written before (#265 S69 e).
- **`maxSteps` and launches** (#273 S68 f): the default (agents + routers) × 3 must hold the worst
  case of a per-item launch (`maxItems` runs) — else `[limits.max-steps-too-low]`; set
  `@Workflow({ maxSteps })`. `.onError(StepsLimitExceededError, …)` (or a parent class) counts as a
  way out for the steps rules.
- **Eval / replay / compare** run within the application's budgets; the judge's calls count in the
  application budgets, held to their last known `maxSpend()` (the eval account `<workflow>:eval` is
  gone).
- `agboss describe`: `limits    steps 2–2 (maxSteps 12)` (no money there; budgets by scope come with
  PR 6).

## Unreleased — the clock (#262, PR 1)

- **`Clock` is public** (root `agboss`, an infrastructure contract): `now()` and
  `sleep(delay, signal?)`. Every time the framework reads and every wait it makes goes through the
  application's one clock — the ledger's day, records, leases and their renewals, the recovery
  sweep, the shutdown timeout, a tool's `timeoutMs`, a model call's timeout, retry backoff and
  `Retry-After` pauses. The system's clock unless `@Application({ providers })` lists a class that
  `extends Clock` (created first; it may not depend on the contexts); in a workflow's `providers`
  it is `[di.infrastructure-in-workflow]`. A component that needs the time injects it
  (`deps: [Clock]`). [Testing → The clock](Testing#the-clock).
- **`VirtualClock` is public** (`agboss/testing`): the `clock` fixture and `app.clock` are one
  per test, the application's clock in every test (also when it lists its own); `new
VirtualClock(start?)` in unit tests. **Breaking:** the `TestClock` type is gone — `VirtualClock`
  in its place (`agboss migrate imports` rewrites the import); its `now` is a method, so
  `clock.now()` reads as before but `clock.now` is no longer a function to pass around.
- **Lint `agboss/no-direct-time`** fails `Date.now()`, `new Date()` / `Date()` without arguments,
  `performance.now()`, `setTimeout`, `setInterval`, `AbortSignal.timeout` and the `node:timers`
  modules in the framework's sources (`SystemClock` excepted).
- **`SqliteConnection` is a value export** (#265 S70): the DI token a subclass of a SQLite
  implementation names. **Breaking** for a project that constructs one of them itself: the
  constructors take `(connection, clock: Clock, applicationContext: ApplicationContext)` (the
  leases and rate-limit slots), `(connection, clock)` (the paused executions; the ledger takes `(connection)` since #261 PR 5) —
  [Several instances → Extending a SQLite implementation](Several-instances#extending-a-sqlite-implementation).
- **Breaking:** the `clock` option of `createApp` / `createAppDeps` (`AppOptions`, `AppDepsOptions`) is removed — one way to set the clock: list a `Clock` subclass in `@Application({ providers })`; tests get the `VirtualClock` from `testWith`.

## Unreleased — child workflows in the grammar and the analyser (#263, PR 1)

- **New: a workflow is a step** ([Workflow as a step](Workflow-as-a-step)): `.toWorkflow(W)`,
  `route(W)`, `workflow(W)` (the own path of a child reached from two places) and
  `.toParallelWorkflows(W, { maxConcurrency, maxItems })` (one child per item, `maxItems` required,
  joined like any launch; `WorkflowLaunchOptions`). Checked and typed by `agboss check`; a workflow
  with a child did not assemble until #263 PR 2 (`flow.child-not-runnable`, removed there).
- **The start is chosen per edge, by class**: one start → it; per item → the start taking the item;
  else the start taking the chain's current value, of several the one whose other required fields
  are on the path — `[graph.no-matching-start]` / `[graph.ambiguous-start]` otherwise, also compile
  errors through the child's `Inputs` entry. `agboss describe` prints each edge's start (`children`;
  `--json`: `children`).
- **The child's result** is its finishes' output classes (`ProducerOutputs`): `.returns(XDto)`, or
  `.returns(oneOf(…)).switch(…)` with one case per class; after a per-item launch the join gives
  `listOf(oneOf(…))` (`JoinOutputs` key `toParallelWorkflows(<child>) per item`). The child's scope
  starts with its start input only.
- **New rules**: `[graph.child-without-failure-finish]` (a warning, an error under `--strict`) and
  `[graph.limit-handler-uses-model]` — **breaking for flows that catch a limit**: an `.onError` /
  `.onJoinError` side path that can catch a `LimitExceededError` (its class, a subclass or a parent
  such as `AGBossError` / `Error`) now fails assembly when it reaches an agent, a router or a child.
- A workflow class mentioned as another kind (`toAgent(SomeWorkflow)`) is `[graph.wrong-kind]`, no
  longer `[graph.not-a-node]`.
- **New: `agboss check --strict`** — the analyser's warnings (`[flow.path-too-deep]`,
  `[graph.child-without-failure-finish]`) are errors (exit 3); flow-patterns' `npm run check` uses it.

## Unreleased — contexts (#261, PR 3)

- **The context levels** ([Context and Authorization](Context-And-Authorization#the-levels-261)):
  `ApplicationContext` (`name`, `version`, `instanceId`, `startedAt`, `environmentName`,
  `environment`, `host` — `HostContext`) → `TenantContext` (`tenantId`, `weight`, #266 S60) →
  `ExecutionContext` (new: `tenant`), each its type and its DI token. New public names:
  `ApplicationContext`, `HostContext`, `TenantContext`, `ContextValues<T>`, `TenantValues`,
  `TenantContextClass`, `ExecutionContextClass`, `CallOptions`,
  `ResumeOptions`, `ExecutionOptionsOf`, `ExecutionOptionsArgs`; `agboss/testing`:
  `TestContextOptions`, `TestApplicationOptions`.
- **The project's subclasses**: `@Application({ tenantContext, executionContext })`; values per
  execution, `app.execute(Start, input, { tenant, execution })`, typed per start by the generated
  types (the `WorkflowStarts` entry names the start's `tenant` / `execution` classes, and a declared
  execution subclass's `tenant` is typed as the tenant subclass), validated before the first step
  (`dto.invalid`, `onRunRejected`), frozen, kept in the checkpoint. New rule codes:
  `[context.prompt-unused]`, `[context.not-declared]`.
- **Breaking — `ENV` is removed**: read the environment as `applicationContext.environment`
  (`deps: [ApplicationContext]`); `[di.missing-environment]` is gone (an application without a
  contract has an empty environment).
- **Breaking — the options are named like the context fields**: `app.execute(…, { threadId,
ownerId })` (was `thread`, `owner`), `app.resume(threadId, decision, { tenantId, ownerId })`,
  `app.cancel(threadId, { tenantId, ownerId })`; `ExecutionOutput.threadId` (was `thread`) and the
  new `ExecutionOutput.tenantId`.
- **Breaking — a thread belongs to its tenant**: its key is `tenantId` + `threadId`;
  `app.cancel` of a thread the tenant does not have throws `UnknownThreadError` (it answered
  `{ cancelled: false }`). The storage contracts take the tenant:
  `ExecutionRecordRepository.createThread(workflow, tenantId, owner?)`, `hasThread(workflow,
tenantId, threadId)`, `threadOwner(workflow, tenantId, threadId)`; every record carries
  `tenantId` (Tern store migration 10); `PausedExecutionRepository.findByTenantIdAndThreadId`,
  `resolveByTenantIdAndThreadId`, `deleteByTenantIdAndThreadId` (were `…ByThreadId`), keyed by the
  paused run's `tenantId`. Leases and tree keys use the execution's tenant (was always
  `"default"`); `holderInstanceId` is `ApplicationContext.instanceId`.
- **SQLite (#265 S69 e)**: `paused_executions` is keyed by `(tenant_id, thread_id)` and the
  `checkpoints` / `checkpoint_writes` rows carry `tenant_id` (the run's `configurable.tenant_id`); a
  file written before is migrated on first use, its rows in the tenant `"default"`.
  `SqliteConnection` reads `sqlitePath` from `applicationContext.environment`.
- **Traces carry the tenant**: a run's LangGraph `metadata` (`tenantId`, `executionId`,
  `rootExecutionId`, `threadId`, `workflowName`, `workflowVersion`) and `tags` (`tenant:<id>`), the
  Langfuse trace's tag `tenant:<id>` and metadata `tenantId`; `TraceContext.tenantId`.
- `testExecutionContext({ tenantContext, tenant, executionContext, execution, application })`.

## Unreleased — model providers as infrastructure (#266, PR 1)

- **Model providers are the application's** ([Model providers](Model-providers#register-them-in-the-application)):
  `@ModelProvider` classes are listed only in `@Application({ providers })` — none listed → the
  built-in `OpenRouterModelProvider` + `DecisionsModelProvider`; one listed → the list is complete,
  the built-ins are not added next to it. A `@ModelProvider` in a workflow's `providers` →
  `[di.infrastructure-in-workflow]`.
- **Breaking — no provider setting on a workflow**: `WorkflowSettings.builder().modelProviders(…)`,
  `.defaultModelProvider(…)` and `WorkflowSettings.models` are removed; move the list to the
  application's `providers`. `AssembledWorkflow.models` → `modelProviders` (the application's list).
- **Every model resolves to exactly one provider by `serves`, at assembly** — agents, model routers,
  the default router, guards, compaction, judges: new rule codes `[model.unserved]` and
  `[model.ambiguous-provider]` (all at once, before any model call). No default breaks a tie: one
  model through two providers is two model strings.
- **Breaking — `ModelProblemCode` `model.no-provider` → `model.unserved`**;
  `ModelProviderDirectory.of(classes)` takes no default provider (`byName`, `defaultProvider` gone).
- `agboss describe` prints `model: … → <provider>` for each model (`--json`: `models`);
  `agboss check --models` checks every model of every workflow of the application.

## Unreleased — parallel launches at run time (#273, PR 2)

- **Launches run** ([Workflow → Parallel launches at run time](Workflow#parallel-launches-at-run-time)):
  each branch is one LangGraph `Send` of one superstep, `maxConcurrency` a sliding window (a paused
  branch frees its slot), the join a node of its own reading only its launch's outcome records
  (launch id `${executionId}:${nodeId}:${visitNumber}`); the join's lists keep listed / item order.
  `flow.launch-not-runnable` is gone.
- **New: `StepFailedError`** (`step.failed`, #273 S22; lineage e.g. `[step.agent, step.failed, step]`) — a step's own failure, naming it: `component`,
  `nodeId` (`critic-agent#2` for a copy), `visitNumber`, `itemIndex`; `StepCoordinates`.
  **Breaking (class hierarchy)** — `AgentFailedError`, `GuardFailedError`, `RouterFailedError`
  (with `RouterDecisionError`) and `ActionFailedError` extend it instead of `PaidStepError`
  directly (still `PaidStepError`s); `AgentAnswerInvalidError`'s and `ActionFailedError`'s
  `component` / `nodeId` come from it, and every step error's record `details` now carries
  `visitNumber` (and `itemIndex` in a per-item run).
- **`FailFast` and `Skip`** (S21): a failed branch aborts its siblings (`BranchStatus.Cancelled`, their
  spend counted) and the join takes the most specific `.onJoinError(E, …)` by class and cause chain,
  else the execution fails with the branch's error; `FailurePolicy.Skip` drops only a
  `StepFailedError` — a limit in a `Skip` branch fails the launch; `app.cancel` during a launch
  cancels the whole execution (`WorkflowCancelledError`), never routed by the join.
- **One visit per launch**: every copy and item of a launch is the same visit of its node (the
  launch's `visitNumber`, told apart by `copyNumber` / `itemIndex`); `maxVisits` counts launches.
- **Router launches** (S23, #280 S47 f): a model router decides its `OnDemand` routes in one call —
  a `Decision.noul` per route on a decision model, one answer tool `answer-launch` with a boolean per
  route on a chat model; all no without an `Always` route → `RouterDecisionError`. A code router's
  `route()` list is launched beside its `Always` targets. Tests script both with
  `decideWith({ "<target>": P(yes) })` ([Testing → Parallel launches](Testing#parallel-launches)).
- **New: `result.launches`** (`ExecutionOutput.launches: LaunchRecord[]` — `launch`, `items`,
  `taken`, `branches: BranchRecord[]`), `BranchStatus`, and the hook `onLaunchItemsTruncated`
  (`OnLaunchItemsTruncated`, `LaunchItemsTruncatedEvent`) when a per-item launch dropped items past
  `maxItems` ([Observability → Parallel launches](Observability#parallel-launches)); a trace entry per
  ended branch (`critic-agent#2`, `company-check-agent[3]`), "launch items truncated" and "launch
  decision". Agent and action events name a copy by its copy id; `toFollowPath` takes the class for
  a copy. A list a join gathered from several agents names each element's producer
  (`ScopeValueRecord.elementProducers`).
- **Example**: `examples/flow-patterns/src/review/` — a section reviewer per section, a mapping
  action, then a style critic beside two fact checker copies.

## Unreleased — the SQLite implementations (#265, PR 3)

- **Every storage contract has a ready SQLite implementation**, enabled only by listing it in
  `@Application({ providers })`: `SqliteExecutionRecordRepository`, `SqliteCostLedgerRepository`,
  `SqlitePausedExecutionRepository`, `SqliteCheckpointSaver` (our own `BaseCheckpointSaver` on
  `node:sqlite`), `SqliteExecutionLeaseRepository`, `SqliteExecutionTreeRepository`,
  `SqliteRateLimitRepository` ([Several instances → SQLite](Several-instances#sqlite--several-instances-on-one-machine)).
  One connection per application instance on the environment's `sqlitePath` — required only when
  one is listed (`[environment.missing-field]`) — WAL, `busy_timeout`, atomic operations in
  `BEGIN IMMEDIATE`, time from the framework's clock.
- **Breaking for your own `ExecutionRecordRepository`**: a new abstract method
  `completeIfStatus(ternId, expected, outcome): Promise<boolean>` — a compare-and-set status write.
  A resume marks its paused record `running` with it, so a write that lands after the holder
  finished the tree no longer leaves a finished record `running` (#265 S66 h).
- **Cross-process persistence is back** for `--thread`, `agboss eval` / `replay` / `golden` when
  the application lists the SQLite implementations (#261 S49 b): a workflow run on its own
  (`createAppDeps`) now uses the infrastructure of the one application that lists it, not always
  the in-memory defaults. job-scout lists all seven (dev: `.agboss/job-scout.sqlite`,
  `AGBOSS_SQLITE_PATH`; tests: `:memory:`).

## Unreleased — parallel launches in the grammar and the analyser (#273, PR 1)

- **Launches** ([Workflow → Parallel launches](Workflow#parallel-launches)):
  `.toParallelAgents(A, B, B, { maxConcurrency })` and `.toParallelActions(…)`, a per-item launch
  (one target right after `.returns(listOf(XDto))`, `{ maxItems }` required), the mandatory
  `.join()`, `.onJoinError(ErrorClass, side path)` and `.join().returns(…)` — checked by the compiler
  against the new generated table `JoinOutputs` (`JoinOutputOf<Key>`) and by the analyser. New
  public types: `LaunchOptions`, `Launched`, `Joined`, `JoinErrorHandling`, `Launches`,
  `RouterLaunches`, `ValuesSource` / `StepValues` / `JoinValues`, the AST's `LaunchStep`,
  `JoinStep`, `JoinErrorHandler`, `LaunchTargetKind`; `StepKind.Launch`, `StepKind.Join`.
- **Breaking (types only) — `Returning<TSource, …>`** takes a values source (`StepValues<X>`,
  `JoinValues<Key>`) instead of a component instance; `AfterValue` and `RouterStep` have a new
  optional type parameter.
- **New rule codes**: `[launch.join-required]`, `[launch.max-items-required]`,
  `[launch.max-items-without-list]`, `[launch.item-not-read]`, `[launch.branch-continued]`,
  `[launch.branch-outdates-sibling]` ([Path scope → Parallel branches](Path-scope#parallel-branches),
  #271 AC9), `[router.spawn-required]`, `[router.prompt-on-always]`; `[router.no-prompt]` for an
  `OnDemand` route without prompt; `[router.all-routes-always]` now applies to router launches.
- **A model router states `spawn` on every route before a launch** (#273 S50,
  [Routing patterns → 6](Advanced-Routing#6-a-router-decides-who-is-launched)); a code router's
  `RouterAnswerOf<Self>` is a list when a launch follows it.
- `agboss describe` prints launches and joins; the steps checks count the copies that always run;
  the worst case of one call of each start is computed with the analysis.
- **Not run yet**: a workflow with a launch passed `agboss check`, but `createApp` stopped with
  `flow.launch-not-runnable` until #273 PR 2 (above).

## Unreleased — environments and defaults (#261, PR 4)

- **Breaking — environments are typed object literals**: the contract is a plain class with declared
  fields only (`environments/app.environment.ts`), declared once in
  `@Application({ environment: AppEnvironment })`; each environment is
  `export const environment: AppEnvironment = { … }` in `environments/<name>.environment.ts`.
  `defineEnvironment`, `fromEnv`, `FromEnv`, `FromEnvOptions`, `EnvironmentValues`,
  `EnvironmentDefinition` and the `declare module "agboss" { interface Environment … }` contract are
  removed; `agboss check` writes `interface Environment extends AppEnvironment {}` into
  `.agboss/types.d.ts`, so `ENV` is typed by the contract ([Environments](Environments)).
- **New**: `env("X")`, `env.integer("X")`, `env.flag("X")` (each with `{ default }`), `secret("X")`
  and `Secret` (prints as `***` everywhere, `.reveal()` gives the value; a literal in a `Secret`
  field does not compile); `EnvironmentErrorCode` (`environment.not-found`,
  `environment.missing-variables`, `environment.invalid-value`, `environment.no-contract`). A missing
  variable fails the start as `DATABASE_URL is not set (AppEnvironment.databaseUrl, prod)`;
  `agboss check --env <name>` lists the variables it needs, marked value / secret.
- **Breaking — tests run on `test`**: `testWith(App)` loads `test.environment.ts` and fails without
  it (no fallback to `dev`); `testWith(App, { environment })` and `createApp(App, { environment })`
  are removed — name an environment with `env`. **Breaking — `@Application({ environment })` is
  required**: an application with no settings declares `environment: EmptyEnvironment` (new, a
  contract without fields), which needs no environment file (its environments are `{}`).
- **New assembly rules**: `[environment.contract-value]` (a value in the contract),
  `[environment.missing-field]` (a listed framework implementation's field missing from the
  contract), `[guardrail.no-model]`.
- **The `defaults` cascade**: `@Application({ defaults })` → `@Workflow({ defaults })` → the
  component's own field, merged field by field, the most specific level wins
  ([Configuration](Configuration#the-defaults-cascade--application--workflow--component-261)).
  **Breaking**: guards take `defaults.guardrail.model` (new), never `defaults.router.model` — a guard
  with no model anywhere fails with `[guardrail.no-model]`. `[router.no-model]` now reads
  `… uses DecidedBy.Model but has no model — set model or defaults.router.model`. `agboss describe`
  shows each router's model and each agent's temperature / maxTokens / history with where it came
  from (`(own)`, `(<application or workflow>)`, `(built-in)`).
- `loadWorkflow`, `studioGraphOf`, `compareProfiles` and `workflowOf` from `agboss/testing` assemble a
  workflow in the application that lists it (its `*.application.ts` next to it or above): its
  providers and `defaults`.

## Unreleased — recovery and the graceful stop (#265, PR 2)

- **Recovery** ([Several instances → Recovery](Several-instances#recovery)): an execution's record
  is `ExecutionRecordStatus.Running` while its tree moves (new public enum, root entry: `Running`,
  `Answered`, `Guarded`, `Failed`, `Paused`); every instance looks for `running` roots at its start
  and every 30 s, takes the lease of one whose holder died or stopped and continues it from its
  last checkpoint (a resolved pause first) — only the interrupted step runs again. A root of another
  config is left to a compatible instance and logged once.
- **Breaking — `ExecutionRecordRepository`**: a new abstract `findByStatus(status, limit, after?)`
  (a page of the records with that status, oldest first). A record is now written when the run
  starts (`running`) and completed when it ends, instead of appended at the end.
- **Breaking — `WorkflowResumeEvent`** has a `reason: ResumeReason` (new public enum:
  `Answered` — `app.resume`; `Recovered` — recovery, `decision` only when it took one).
- **The graceful stop**: `app.close(options?)` stops the sweep, runs `onStop`, waits for the running
  executions up to the shutdown timeout — `@Application({ shutdownTimeout })`,
  `app.close({ timeout })` (`CloseOptions`), default `seconds(25)` — then interrupts them: the call
  rejects with `ApplicationStoppingError`, no `onError`, the lease released at once, the record
  left `running` for recovery ([App → app.close()](App#appcloseoptions)).
- **SIGTERM / SIGINT**: `createApp` calls `app.close()` on either (a second one interrupts at
  once); the listeners are removed when `close()` finishes, and the signal is raised again when
  nothing else listens. `testWith` never listens.

## Unreleased — the paths DSL revised: one value per `.returns`, `{ about }` in the flow, `historyOf` (#299)

- **Breaking — `.returns(value, options?)` names one value** (#272 S54): a DTO class, `optional(…)`,
  `listOf(…)` or `oneOf(…)`. Several values (a start's map of fields) are a chain,
  `.returns(CompanyDto).returns(optional(SearchRequestDto))`, in any order; `.returns(A, B)` does not
  compile (untyped code: `FlowSyntaxError`). `ReturnsStep` holds one `value`.
- **Breaking — a `oneOf` output is written before its switch**: `.returns(oneOf(A, B)).switch(…)`;
  a `.switch` without it, or with another `oneOf`, is `[flow.returns-mismatch]`.
- **Breaking — `about(TargetDto, shape)` is removed** (with `AboutWrapper`, `DeclaredOutput`):
  components declare a plain `output`; the flow says what a value is about —
  `.returns(CritiqueDto, { about: PlanDto })`, `{ about: [PlanDto, BudgetEstimateDto] }`, and for a
  `oneOf` on the case, `caseOf(ChangesRequestedDto, { about: OfferDraftDto })` (never on
  `.returns(oneOf(…))`). A value's `about` slots are kept on `ScopeValueRecord.about`.
  `{ about }` on a start's `.returns(…)` does not compile (`[io.about-on-start]` at assembly).
  `[io.ambiguous-cycle]` hints name the `.returns` / `caseOf` to write it on.
- **Breaking — no string tags** (#272 S56): `{ as: "before" }`, the tag slots, their labels
  (`DraftDto[before]#1`) and `[flow.unused-tag]` are removed. **New `historyOf(Dto, { limit })`** in
  `input` (root entry and `agboss/dto`; `HistoryOf<T>`, `HistoryWrapper`, `HistoryOptions`): the field
  is `{ current, previous }` — the current value and the earlier versions oldest first, at most
  `limit` — typed `HistoryOf<Produced<Dto, P>>` in `InputOf`, shown in the input message
  (`### draft, earlier versions (oldest first)`) and by `describe`. It needs a current `Dto` on every
  path (`[input.missing-on-path]`); the replaced versions are never `[input.outdated-on-path]`; a
  `limit` that is not a positive integer → `[input.history-limit]`.
- **`[io.ambiguous-about]`** now: a producer whose values are `{ about: T }` reading `T` in two or
  more fields (with `historyOf(T)` the answers are about its current value);
  **`[flow.ambiguous-field]`**: two fields of one node that read one slot.
- **Breaking — `listOf(oneOf(A, B))` is one slot** (#272 S53): the filtered `list:ADto` / `list:BDto`
  slots are gone; a `listOf(ADto)` field after such a step is `[input.missing-on-path]`.
- [Path scope](Path-scope), [Workflow](Workflow), [Components](Components),
  [Standard DTOs](Standard-DTOs).

## Unreleased — the shared contracts and the execution lease (#265, PR 1)

- **New infrastructure contracts** (root entry), each with a built-in in-memory default, listed only
  in `@Application({ providers })` and found by inheritance: `ExecutionLeaseRepository`
  (`acquire(tenantId, rootExecutionId, lease)`, `renew`, `release`; `ExecutionLease { tenantId,
  rootExecutionId, holderInstanceId, leaseEpoch, expiresAt }`), `ExecutionTreeRepository`
  (`saveIfAbsent(key, value)` / `findById(key)` inside an execution; an implementation provides
  `saveIfAbsentInTree`, `findByIdInTree`, `deleteAllInTree`) and `RateLimitRepository`
  (`acquire(key, maxSlots, lease)`, `renew`, `release`; `RateLimitLease`). There is no
  `ExecutionSlotRepository` ([Several instances](Several-instances)).
- **The execution lease** (Q58): `app.execute` and `app.resume` move a tree only while holding its
  lease (`seconds(30)`, renewed every 10 s and before every checkpoint write, released when the pass
  ends). An instance that lost it stops, and its call rejects with `ExecutionLeaseLostError`
  (`execution.lease-lost`) — no `.onError`, no `onError`, no failed record: the new holder continues.
- **Breaking — `PausedExecutionRepository`**: a paused run has a `status` (`PauseStatus.Pending` /
  `Resolved`) and, once resolved, its `decision`; a new abstract `resolveByThreadId(threadId,
  decision)` turns a pending pause to resolved atomically. A resume records its decision first
  (a second resume of the same pause → `NotPausedError`), then waits for the tree's lease; the holder
  takes decisions resolved meanwhile and the waiting call returns the tree's current output.
- **Tree keys** of `ExecutionTreeRepository` are removed when the tree finishes, fails or is
  cancelled; a pause keeps them.
- **Testing**: `testWith(App, { instances: 2 })` with the fixtures `apps` and `clock`;
  `clock.advance` takes `seconds(…)` too and returns a promise — **`await` it** (the framework's
  waits sleep on the test clock) ([Testing](Testing)).

## Unreleased — `@Application`, infrastructure, the test entry (#261, PR 2)

- **Breaking — `@Application` is the one entry**: `@Application({ name, version, workflows,
  providers, budgets })` (`name` ends with `-application`, the class with `Application`), and
  `createApp(App, { env })` / `testWith(App)` take it. `createApp(Workflow)` and `testWith(Workflow)`
  are removed — they do not compile (the generated `.agboss/types.d.ts` brands every workflow) and
  fail at run time naming the fix. `app.execute(Start, …)` runs the workflow of that start (any
  workflow of the application); `resume` / `cancel` find the workflow of the thread; `app.name` /
  `app.version` are the application's. Environments are found next to the application file
  ([App](App), [Testing](Testing)).
- **New assembly rules** (`GraphRuleError`, all at once): `[application.no-workflows]`,
  `[application.not-a-workflow]`, `[application.duplicate-workflow]`, `[application.ambiguous-start]`
  (one start in two workflows), `[graph.duplicate-node-name]` across workflows,
  `[budget.not-a-budget]`, `[di.infrastructure-in-workflow]`, `[name.kind-suffix]` on the
  application and on budgets.
- **Infrastructure**: `CostLedgerRepository`, `ExecutionRecordRepository`,
  `PausedExecutionRepository` (new, root entry) and LangGraph's `BaseCheckpointSaver` — listed only in
  `@Application({ providers })`, found by inheritance, each with a built-in in-memory default.
  **Breaking**: `createApp({ stores, pausedRuns })`, `AppStores`, `PausedRunRepository` and
  `createSqlitePausedRunRepository` are removed, and **nothing is written to the home folder any
  more**: execution records (Terns) and the spend ledger were SQLite / JSONL files under
  `~/.langgraph-agents/` (`TERN_DB`, `SPEND_LEDGER_DIR`) and are now in memory — gone on restart,
  so `agboss eval` / `replay` only see records of their own process until the SQLite
  implementations of #265 are listed ([App → Infrastructure](App#infrastructure)).
- **Budgets, declarative**: `@Budget({ name, scope, period?, workflow?, deps? })` on a class that
  `implements BudgetHandler` (`maxSpend(): Usd | Promise<Usd>`), `BudgetScope.Application | Tenant |
  Execution`, `BudgetPeriod.Day | Week | Month`, all listed in `@Application({ budgets })`
  (`config/budget.config.ts`). They are components (injectable, `mockOf`-able); the checks at run
  time come with #261 PR 5 — until then `settings().limits` caps the money ([FinOps](FinOps#budgets)).
- **Tests**: every framework fixture and test runs through an `@Application`; `app.ready()` builds
  the test's application for a test that executes nothing; each test runs on the infrastructure the
  application lists (else the in-memory defaults), new per test.
- **CLI (until #268)**: `agboss run` / `chat --workflow <file>` run the application that lists the
  workflow — exported by its module, or by a `*.application.ts` in its folder or a folder above it —
  at that workflow's text start. `agboss create` / `generate workflow` write the workflow's
  `*.application.ts` and `config/budget.config.ts`.

## Unreleased — one container per application instance (#261, PR 1)

- **Breaking — no scopes**: one container per application instance, one instance per class (a class
  listed by two workflows is one instance). The `scope` option of every DI decorator, the `Scope`
  type, the run-scoped container and `[di.scope-mismatch]` / `[di.run-scope-outside-run]` are gone
  (against #184). Components keep no state: read the execution from `ExecutionContext`, keep data that
  outlive a step in the graph state, caches in your own service over external storage
  ([Components → Components keep no state](Components#components-keep-no-state)).
- **Breaking — lint**: `agboss/no-component-state` replaces `agboss/no-run-state-in-singleton` —
  `this.x = …` outside the constructor of any component is an error.
- **Lifecycle hooks**: `OnInit` (new in the root entry), `OnStart`, `OnStop`, `OnDestroy` — `onInit`
  (dependencies first) → `onStart` at start, `app.close()` → `onStop` → the running executions awaited
  → `onDestroy` (dependants first). A failing `onInit` / `onStart` stops the start
  (`[di.hook-failed] <Component>.<hook> failed: …`); failing stop hooks are collected into one
  `AggregateError`. After `app.close()` `execute` / `resume` reject with the new `ApplicationStoppingError`
  (`app.stopping`, an `onRunRejected`); `cancel` still works.
  **Breaking**: `AfterAssemble` is removed, `OnDestroy` now runs once at shutdown, not per run
  ([App → Lifecycle hooks](App#lifecycle-hooks)).
- **Implementation by inheritance**: a dependency on a contract gets the one listed class that extends
  it; two → `[di.ambiguous-implementation]`. One token with different values →
  `[di.conflicting-values]`; `provide(Class, …)` → `[di.instance-provider]` (no `new`: the container
  creates every instance) ([Components](Components)).
- `createAppDeps(…).close(executionsDone?)` takes what to wait for between `onStop` and `onDestroy`.

## Unreleased — code routers (#280)

- **`DecidedBy.Code`**: a router decided by its class — `implements RouterHandler<Self>`,
  `route(input: InputOf<Self>)` returns one of its targets (`Route<Self>`, generated; a target outside
  `routes` does not compile); `deps` in the constructor like an action, the execution through
  `deps: [ExecutionContext]`. No model call, cost 0, the same flow as a model router
  ([Routers → Routers decided by code](Routers#routers-decided-by-code),
  [Routing patterns](Advanced-Routing)).
- **`@Router` options are a union by `decidedBy`** (`ModelRouterOptions` / `CodeRouterOptions`):
  `model`, `prompt`, `promptUrls`, `promptVariables` and route `prompt`s only on a model router;
  `deps` only on a code router.
- **`spawn` / `failure` on routes** (`SpawnPolicy.Always | OnDemand`, `FailurePolicy.FailFast | Skip`),
  both kinds — the options of a parallel launch (#273). Defaults `Always` + `FailFast`; a code
  router's route `OnDemand`. With `.chooseOne(…)` an explicit one → `[router.policy-with-choose-one]`
  and `Route<R>` is every target; before a launch `Route<R>` leaves `Always` targets out and every
  route `Always` → `[router.all-routes-always]`. The generated `RouterAnswers` table types what
  `route()` returns.
- **Breaking — router errors (S19)**: `RouterFailedError` (`step.router`, the original as `cause`: a
  model call or `route()` failed) and `RouterDecisionError` (`step.router.invalid-decision`, now a
  `RouterFailedError`: an answer outside the routes, a list after `.chooseOne(…)`, an unreadable
  answer — never retried). Both carry `component`, `nodeId`, `visitNumber`. The instance codes
  `router.failed` / `router.unknown-route`, the type `RouterFailureCode` and the field `router` are
  gone (`router` → `nodeId`); an unreadable model answer is now `RouterDecisionError`, not a failure.
  `.onError(RouterFailedError, …)` takes both; `.onError(DomainError, …)` the error inside.
- `agboss describe` lists code routers as `code`; `mockLlm(CodeRouter)` throws (a code router calls
  no model — `mockOf()` its services).

## Unreleased — one call per line in flow chains (#289)

- **Style**: a flow chain has one call per line — `start(A)` / `.returns(B)` / `.toFinish(C)`, and
  `route(X)` / `.toFinish(F)` inside a `chooseOne(…)` ([Workflows](Workflow) → The grammar). In the
  repo, `*.workflow.ts` modules and the flow fixtures are left out of Prettier (which joins short
  chains), formatted by `make fmt` and checked by ESLint's `@stylistic/newline-per-chained-call`;
  the docs' and Wiki's ts snippets that build paths are checked by `npm run check:docs`
  (`doc:line: … (@stylistic/newline-per-chained-call)`). `agboss create` / `agboss generate` write
  workflow modules one call per line.
## Unreleased — outdating at run time (#271)

- **`scope` holds current values only**: a write moves the older value of its slot and everything
  built from it to `outdatedValues`, each with `outdated: { byValueId, reason }` — `byValueId` the
  root trigger, `reason` an `OutdatedReason` (`Replaced`, `AboutReplaced`, `BuiltFromReplaced`)
  ([Path scope → At run time](Path-scope#at-run-time)). `OutdatedValueRecord.outdated` gains
  `reason`.
- **`onValuesOutdated`** (`OnValuesOutdated`, `ValuesOutdatedEvent`): one event per cascade, never
  empty, no DTO values; with `ExecutionEvent`'s fields (`executionId`, `parentExecutionId`,
  `rootExecutionId`, `threadId`, `workflow` as a `WorkflowRecord`) and `step` (a `StepRecord`)
  ([Observability](Observability#outdated-values)); one "values outdated" trace entry per cascade.
- **Records**: `WorkflowRecord`, `StepRecord`, `ScopeValueReference`, `OutdatedValueReference`,
  `OutdatedMark`; `WorkflowDescriptor`, `StepDescriptor` and `ComponentDescriptor` extend them.
- **`agboss describe`** prints each `about(…)` output ([CLI](CLI)).

## Unreleased — the execution context (#280)

- **`ExecutionContext`**: the one context of an execution, injected through the constructor —
  `deps: [ExecutionContext]`, a parameter named `executionContext` — into tools, actions, judges and
  services ([Context and Authorization](Context-And-Authorization)). Read-only data: `executionId`,
  `threadId`, `ownerId`, `signal`, `workflow`, `step` (`idempotencyKey` =
  `${executionId}:${nodeId}:${visitNumber}[:${itemIndex}][:${callId}]`, `callId`, `visitNumber`, …)
  and the tree (`parent`, `root`, `depth`, `executionOf(W)`). A read outside an execution or after
  its step ended throws `ExecutionContextUnavailableError` (`context.unavailable`).
- **No `ctx` parameter**: `ToolHandler.run(input)`, `@McpTool` alike; `ToolContext` and `RunContext`
  are gone (`ctx.run.runId` → `executionContext.executionId`, `ctx.run.owner` → `.ownerId`,
  `ctx.run.signal` / `ctx.signal` → `.signal`, `ctx.callId` → `.step.callId`, side effects key on
  `.step.idempotencyKey`). `ctx.run.metadata` and `ctx.run.input` have no replacement in the context:
  domain data come through a node's `input`. `ctx.pause(question)` is **removed until #267**
  (questions as part of the graph; S44) — approval of a tool call through `@Tool({ channel })` keeps
  working. `ctx.reportCost(usd)` → `deps: [SpendRecorder]`, `spendRecorder.record({ service, cost })`
  (S43), counted in the money limits; a tool's `ROUTER_FACTORY` decisions are accounted as its
  spend by the framework.
- **A tool call's signal** (S45): in a tool call `executionContext.signal` aborts on the execution's
  cancel and at the tool's own `timeoutMs`.
- **Judges**: `judge(input: JudgeInput)` (`reply`, `task`, `attempt`) instead of
  `judge(reply, ctx: JudgeContext)`; the judge's model through `deps: [JudgeModel]`
  (`judgeModel.invoke` / `judgeModel.decide`).
- **Testing**: `testExecutionContext({ … })` replaces `testRunContext()`; `toolOf(tool).invoke(input)`
  takes no context; `app.tool(T).invoke(input)` runs the tool in an execution of its own.
- An exported tool called over MCP runs in an execution of its own; the client's `_meta.callId` is
  its `step.callId`.

## Unreleased — the flow as paths (#272, #270, #269)

- **Outdating** (#271, [Path scope](Path-scope)): a field reads only current values — a new value
  outdates everything built from the older one, and assembly proves no node reads an outdated value
  (`[input.outdated-on-path]`). In a cycle of classes built from each other the component that
  answers says what about: `output: about(DraftDto, oneOf(ApprovalDto, DraftChangesDto))`
  (`[io.ambiguous-cycle]`, `[io.ambiguous-about]`). A review loop written without `about` no longer
  assembles; the hint names the output to wrap.

- **The flow is a list of paths** ([Workflow](Workflow), [ADR-0019](ADR-0019-Flow-as-paths-with-path-scope)):
  `start(S).returns(Dto).toRouter(R).chooseOne(route(A)…)`, `.toAgent` / `.toAction` / `.toFinish`,
  `.switch(caseOf(…))`, `.onError(E, <side path>)`; own paths `agent(X)…` / `router(R)…` /
  `action(A)…` for shared nodes. Removed: `from(…).next(…)`, `from(R).routes()`, `chain`, `node`,
  `catchError` / `compensateWith`, `nextParallel` / `join`, `batchParallel`, `joinQuorum`,
  `@QuorumRouter`, `parallel(…)` / `optional(…)` route targets, `Self`, nested `@Workflow` nodes,
  sagas and `compensate`, the `agboss/concurrency` entry. Parallel launches return in #273, child
  workflows in #263, code routers in #280.
- **Generated types**: `agboss check` writes `.agboss/types.d.ts` (git-ignored) — what types the
  paths, `InputOf<X>` / `OutputOf<X>` and `app.execute(Start, input)`. A generated project runs it on
  install (`npm run types`); `declare readonly input` on a start is no longer needed.
- **Typed data on paths** ([Path scope](Path-scope)): `@Agent` / `@Action` / `@Router` /
  `@WorkflowFinish` take `input` fields and `output` shapes; wrappers `listOf`, `oneOf`, `optional`,
  `variant`, `isVariant` (`agboss/dto`). Agents read an input message after static instructions and
  answer a structured `output` through answer tools; `{{item}}` and `{{input.…}}` in instructions are
  gone (`[prompt.input-in-instructions]`).
- **Names**: every component `name` ends with its kind (`main-router`, `scout-agent`,
  `chat-workflow-start`, `charge-action`, `job-scout-workflow`) and is unique in the application;
  DTO classes on paths end with `Dto` — the standard DTOs are renamed (`WorkflowStartText` →
  `WorkflowStartTextDto`, `Money` → `MoneyDto`, …, [Standard DTOs](Standard-DTOs)). LangGraph node ids
  are the names (no `<kind>.` prefix).
- `@WorkflowAction` → `@Action`, `execute(input)` with its fields from the path's scope
  (`ActionHandler<Self>`). `ctx.run`, `ctx.idempotencyKey` and `ctx.executionContext` are gone
  from actions — since #280 the execution comes through `deps: [ExecutionContext]` (above).
- **Limits**: `@Workflow({ maxSteps })` replaces `limits.perRun.steps`; `maxVisits` on routers and
  agents (`VisitsLimitExceededError`, catchable with `.onError`); money stays in `settings()`.
- **Results**: `ExecutionStatus.Finished | Paused`; `result.finish` is `{ name }`; `{ record: true }`
  adds the execution record. The thread's history keeps finished executions as
  `start <name>: <input>` / `finish <name>: <output>`.
- **Enums instead of strings** (#269): `Reasoning.…` instead of `thinking` strings on components,
  `RagMode.Tool | Context`, `ModelKind`, `ProviderSort`, `ImageDetail`, `ExecutionStatus`.
- `defaults.router` is `{ model }` (no `kind`); a `@Router` takes `decidedBy: DecidedBy.Model` and a
  required `input`.
- job-scout: one path per turn, names with their kinds, profiles and golden sets under
  `job-scout-workflow/` ([Example](Example)).
