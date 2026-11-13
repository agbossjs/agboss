---
section: Breaking
issue: 895
---

**The public surface of #895 is narrowed before the 0.1.1 freeze** (#895): the acceptance of the
first change found 217 names exported, not the 30-40 expected. This entry replaces what its "Exported"
bullet says; no code of yours writes the type-machinery names, and none of the removed names is in a
released version.

- **Exported**, only what a user writes or reads in a signature: `AgentSettings`, `AgentSettingsOf`,
  `BindToolOptions`, `ChannelOptions`, `CustomCompactionOptions`, `StartEvent` / `EndEvent`,
  `ExecutionStreamEvent`, `RouteOption` / `RouteRequest` / `RouteOutcome` / `RouterDecision` and the
  route, finish and start option types (root); `ListOptions`, `OneOfOptions`, the limits and
  `ToolArguments` (`/dto`, a type); the wire types, `Price`, `MaxTokens`, `ModelEntry` and the
  provider options (`/models`); `McpServerConfig` (`/mcp`); `RagResultCount` (`/rag`);
  `ConcurrencyMode` (a string-literal union now, no longer an enum), `EnvironmentSelection`,
  `JudgeRunnerInput`, `ServerToolHandlers`, `StudioGraph`, `ToolOutput` (`/testing`).
- **The type machinery is one `@beta` namespace per entry** (not a contract, names may change):
  `FlowTypes` in the root (`FlowTypes.Same`, `FlowTypes.Member`, `FlowTypes.KindOf`, … and the
  settings pieces `FlowTypes.ModelSettings`, `Thinking`, `CacheSetting`), `TestingTypes`
  (`/testing`), `DtoTypes` (`/dto`), `EvalTypes` (`/eval`). Nothing of it was in the root before
  0.1.1, no code of yours writes these names.
- **Left the public entries (wiring that leaked):** the SQLite pause store's base chain
  (`SqlitePauseStore`, `SqlitePauseQueryRepository`, `SqlitePausedRunRepository`, the row and scan
  helpers, `StoredMailbox`, `PlannedNotice`) and `TurnStoreRecordRepository`, `TurnRecords`,
  `TurnStore`: `SqlitePausedExecutionRepository` and `SqliteExecutionRecordRepository` now extend
  `PausedExecutionRepository` / `ExecutionRecordRepository` directly and delegate to a private store
  (a subclass of either overrides methods as before; no `connection`, `page({ clause, values })`
  nor row helper is reachable); `gateway` of `CompareProfilesOptions` and `StudioOptions` (tests use
  `compareProfilesWith` / `studioOfWith` of `/internal`; `ModelGateway` and LangChain's
  `BaseChatModel` are no longer named by the root); `ModelProviderDirectory` (now in `/internal`,
  with `ProviderQuery`, `ProviderResolution`, `RegisteredModelProvider`, `KeptModelProviderOptions`
  out of `/models`); `McpServerClient.attachServerTools` (`@internal`; `ServerToolCallable` and
  `ToolInvocationContext` out of `/mcp`); the matcher objects `workflowMatchers`, `childMatchers`,
  `compensationMatchers` and `toolCallMatchers` of `/testing` (`agboss/testing/setup` registers
  them, `MatcherContext` and `Verdict` are gone).
- **The zod schemas are internal again.** `AgentSettings`, `AgentsConfig`, `CompactionSettings`,
  `McpServerConfig`, `MaxTokens` and `Price` are interfaces and unions written out (no
  `z.infer`), so the zod version is no part of the API; `AgentSettingsSchema`, `AgentsConfigSchema`,
  `CompactionSettingsSchema`, `McpServerConfigSchema`, `MaxTokensSchema` and `PriceSchema` are not
  exported. `ConcurrencyMode`, `Wrapper` and `ToolArguments` add no runtime value to their entries.
- **Inlined** (named by no entry now): `AgentMeta`, `RagBinding`, `GuardrailFields`,
  `PiiPolicyFields`, `CompactionFields`, `ToolInterceptorFields` (the fields are written in
  `AgentOptions`, `ModelRouterOptions` and `CodeRouterOptions`), `ChannelMeta` (`ChannelOptions`),
  `ChannelRoleForm`, `AutoDecision`, `ComponentClass`, `StartClass`, `ActionClass`, `ModelTarget`,
  `ContextFields`, `RecordedInput`, `WireFields`, `ProviderFetch`, `ModelProviderClass`,
  `ToolHandlerClass`, `AgentToolClass`, `QuestionRoleClass`, `ModelProviderBaseOptions`,
  `ListLimits`, `OneOfValues`.
- **`npm run check:api` names a signature that uses an `@internal` type** (one `stripInternal`
  removes from the declarations) with the #895 message, no longer an api-extractor `InternalError`.
- **`withProfile` has public replacements:** in a test `testWith(App, { profile, profileRoot })`
  (`app.settings` shows what the profile applied), in production `createApp(App, { profile,
profileRoot })`, on the command line `agboss describe --profile <name>`.
