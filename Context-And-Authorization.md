# Context and Authorization

An execution has two kinds of data: the **state** it works on (the path scope, persisted by the
checkpointer — it survives steps, pauses and the next execution of the thread) and the **execution
context** — which execution and which step is running, and who the thread belongs to. Domain data
always come through a node's `input`; the context carries identity and execution metadata only.

## The levels (#261)

The contexts form one hierarchy, like Spring's `ApplicationContext`; each level links up, and a
component takes the one object of its level and reaches everything above through it:

```
ApplicationContext        the application: name, version, instanceId, startedAt, environmentName, environment, host
└── TenantContext         the organization: tenantId, weight + the project's own fields (units, plan, …)
    └── ExecutionContext  one execution: executionId, threadId, ownerId, tenant, signal, workflow, the tree, step
        └── step          component, nodeId, visitNumber, idempotencyKey, callId, itemIndex, copyNumber
```

Exactly three context tokens exist, each its type and its DI token: `deps: [ApplicationContext]`,
`deps: [TenantContext]`, `deps: [ExecutionContext]` (or the project's subclass of a level, below).

- **`ApplicationContext`** — an immutable description of the running instance, one object, made by
  the framework at start: `name`, `version` (`@Application`), `instanceId` (the holder of its
  leases, [Several instances](Several-instances)), `startedAt` (the framework's clock),
  `environmentName` (`"prod"`), `environment` (the values, typed by the contract —
  [Environments](Environments)) and `host` (`hostname`, `pid`, `platform`, `runtimeVersion`). It is
  readable at any time: startup services, observers, budgets. There is no separate environment
  token: `this.applicationContext.environment.auditUrl`.
- **`TenantContext`** — the organization the execution works for: `tenantId` (`"default"` when the
  execution names none), `weight` (a positive integer, default 1 — its share of a model provider's
  slots under `QueueBalancingStrategy.TenantWeighted`, #266) and the project's own fields;
  `tenantContext.application` links up.
- **`ExecutionContext`** (#280) — one execution, `executionContext.tenant` and through it
  `executionContext.tenant.application`: the same objects, not copies.

`TenantContext` and `ExecutionContext` read the current execution on every access; read outside
one they throw `ExecutionContextUnavailableError` (below) — `ApplicationContext` never does.

## `ExecutionContext` (#280)

`ExecutionContext` is the one context of an execution. Any component — a tool, an action, a judge,
a service — takes it through its constructor, like every other dependency: `deps: [ExecutionContext]`
and a constructor parameter named `executionContext`. There is no `ctx` parameter anywhere: tools,
actions and judges get only their input.

| Field                     | What                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| `executionId`             | unique per execution, the same after a resume (`ExecutionOutput.executionId`)                  |
| `threadId`                | the conversation (`ExecutionOutput.threadId`)                                            |
| `ownerId`                 | from `execute(…, { ownerId })`: who the thread belongs to; `undefined` for an open thread |
| `tenant`                  | the execution's `TenantContext` (the declared subclass); `tenant.application` above it    |
| `signal`                  | aborted by `app.cancel(threadId)` or the caller's `signal`; in a tool call also at the tool's `timeout` |
| `workflow`                | `{ type, name, version, startedVersion, configHash }` — the `@Workflow` class, its name, versions, its fingerprint (#268 S93) |
| `step`                    | the step running now (below) — different in each parallel branch and each tool call      |
| `parent`, `root`, `depth` | the execution tree: one level until #263 (`parent` `undefined`, `root === this`, `1`)    |
| `executionOf(W)`          | the nearest execution of workflow `W` in the chain (this one included), else `undefined` |
| `itemIndex`               | the index of a child launched per item (#263); `undefined` otherwise                     |

`step`: `component` (`{ type, name, kind, promptHash, schemaHash }` — the join keys of
[Observability](Observability#join-keys)), `nodeId` (the node's id in `result.path` and traces —
`critic-agent#2` for the second copy of a repeated target of a launch),
`visitNumber` (the pass through this node, from 1 — the counter `maxVisits` checks), `callId` (the
model's tool-call id while a tool call runs, else `undefined`), `itemIndex` (per-item launches,
#273), `copyNumber` (from 1, #273), `toolLoopIteration` (an agent's model call in the visit, from 1,
during it and its move's tool calls), `validationAttempts` (the step's answers and tool arguments
that failed validation so far) and `idempotencyKey`:

```
${executionId}:${nodeId}:${visitNumber}[:${itemIndex}][:${callId}]
```

In a step `signal` is the execution's; in a tool call's frame it is the call's own —
`AbortSignal.any` of the execution's signal and a timer of the tool's `timeout`, cleared when the
call ends (S45) — so a request passed that signal stops on a cancel and on the call's timeout.

One key per operation: every pass of a cycle, every item and every tool call has its own; a retry,
a judge's retry and a resume keep it, so an external service recognises the repeat. Pass it to the
service's own idempotency key ([Cancellation and idempotency](Saga-And-Cancellation)).

The injected object is not a snapshot: every read gives the current execution and step (one
`AsyncLocalStorage` frame per node visit and per tool call, closed when it ends), so it is safe in an
app-scoped component and in parallel branches. It is read-only and holds no input, no metadata and
no access to the container.

- **Outside an execution** — in a constructor at application start — a read throws
  `ExecutionContextUnavailableError` (`code: "context.unavailable"`), naming the class and the field
  it read: `AuditService read executionContext.executionId outside an execution. Read it inside a
method called during an execution, or take ApplicationContext.` (`tenantContext.units` for the
  tenant level). Injecting it is always allowed; only reading it fails, never with `undefined`.
- **After its step ended** — a forgotten promise reading it once the tool call or the step returned —
  it throws the same error naming the ended step: `the execution context was read after its step
ended (payment-agent:1 tool call call_7f3a in execution 4f1c…)`. A tool call's frame closes while
  its agent goes on; a read never falls back to the agent's frame. What code already took out of the
  context (the `step` object, the `signal`) keeps working.

## The project's levels: subclasses

The levels are fixed (application → tenant → execution → step); the project extends the tenant and
the execution level by **subclassing** them, with DTO field decorators (`agboss/dto`), and declares
the subclasses once, `@Application({ tenantContext, executionContext })` — workflows declare none.
How an organization is structured inside (clinics → units → wards) is data in the tenant
subclass, nested with `@ListOf` / `@Nested`, not new framework levels.

- Fields of a context take **no `prompt`**: no model reads a context, the field's name is its
  meaning — a `prompt` fails assembly, `[context.prompt-unused] ClinicTenantContext.units has a
prompt — no model reads a context; remove it`. A field without a decorator fails it too
  (`dto.undecorated-field`).
- A component injects the subclass as its token (`deps: [ClinicExecutionContext]`, a parameter
  named after its type); the base token (`deps: [ExecutionContext]`) gives the same subclass's
  object. A subclass the application does not declare → `[context.not-declared] … — @Application({
executionContext: ClinicExecutionContext })`.
- `agboss check` types a declared execution subclass's `tenant` as the declared tenant subclass,
  so `this.clinicExecutionContext.tenant.units` is typed.
- **Identity, never secrets:** the levels hold who we interact with (ids, roles, licence numbers),
  never access tokens, passwords or API keys. Identity that must not reach a model, a log or a trace
  is marked `sensitive: PiiAction.…` (#120 — a masking action only: `replaceWithKind()`,
  `replacePart(…)`, `replaceWithToken()`; `blockWithRefusal` does not compile there): its value is
  masked wherever it appears in what a model reads, and the context fields in a trace of the state
  are masked too ([Guards → PII policies](Guards#pii-policies)); a service gets a secret from the identity when it needs one
  (`credentialService.tokenFor(clinicianId)`), so it is never checkpointed, never inherited and
  never stale after a pause.

```ts file=clinic.context.ts
import { ExecutionContext, Injectable, PiiAction, TenantContext } from "agboss";
import { ListOf, Nested, Text } from "agboss/dto";

export class UnitDto {
  @Text()
  unitId!: string;

  @Text()
  name!: string;
}

export class ClinicianDto {
  @Text({ sensitive: PiiAction.replaceWithToken() }) // the model sees <clinician-id:…>
  clinicianId!: string;
}

// config/context.config.ts — the project's tenant level
export class ClinicTenantContext extends TenantContext {
  @ListOf(UnitDto)
  units!: UnitDto[];
}

// the project's execution level: who talks now
export class ClinicExecutionContext extends ExecutionContext {
  @Nested(ClinicianDto)
  clinician!: ClinicianDto;

  @Text()
  unitId!: string;
}

// the organization's level
@Injectable({ deps: [ClinicTenantContext] })
export class UnitDirectoryService {
  constructor(private readonly clinicTenantContext: ClinicTenantContext) {}

  unitName(unitId: string): string {
    const unit = this.clinicTenantContext.units.find((candidate) => candidate.unitId === unitId);
    return unit?.name ?? unitId;
  }
}
```

### The values, per execution

`app.execute(Start, input, { threadId, ownerId, tenant: { … }, execution: { … } })` — `tenant` and
`execution` are `ContextValues<T>` of the declared subclasses: their data fields only, without the
links up and without what the framework fills (`executionId`, the tree, `step`); a tenant's
`tenantId` and `weight` are optional. A project's loader returns them:
`async contextOf(tenantId: string): Promise<ContextValues<ClinicTenantContext>>` — where the data
come from is the project's choice; the framework loads nothing.

- Typed per start by the generated `.agboss/types.d.ts`: with declared subclasses their values are
  required; with nothing declared `tenant: { tenantId?, weight? }` is optional (omitted → the
  tenant `"default"`) and passing `execution` does not compile.
- Validated by the field decorators before the first step: invalid → the execution is rejected
  with `dto.invalid` and `onExecutionRejected`; the message names the field, never the value
  (`invalid ClinicTenantContext: units[0].unitId: …`).
- Frozen for the whole execution, kept in its checkpoint: a resume — `app.resume({ pauseId,
  decision }, { tenantId, ownerId | answeredBy })` ([Pauses](Pauses)) — runs on the values it
  started with, and takes only the tenant's id (a plan changed meanwhile applies from the next
  execution). Child executions (#263) inherit them.

### A thread belongs to its tenant

The key of a thread is `tenantId` + `threadId`: another tenant's thread does not exist for the
caller — `execute(…, { threadId })` and `app.cancel(threadId, { tenantId })` throw
`UnknownThreadError` (with no hint that the id is taken elsewhere), `app.resume` finds no pause
(`NotPausedError`). Inside the tenant `ownerId` stays the access key (`ThreadOwnerError`).
Every record the framework stores carries `tenantId` — the execution records, the paused
executions, the leases and the tree keys — and so does what it sends: a run's LangGraph `metadata`
(`tenantId`, `executionId`, `rootExecutionId`, `threadId`, `workflowName`, `workflowVersion`) and
`tags` (`tenant:<id>`, the workflow), and the Langfuse trace (tag `tenant:<id>`, metadata
`tenantId`), so traces filter by organization.

## Authorization in a tool

A thread created with an `ownerId` belongs to it: `execute` on that thread, `resume` and `cancel` with
another owner (or none) throw `ThreadOwnerError` (`run.thread-owner`) before anything runs or is
read. Inside the execution a tool reads the owner as `executionContext.ownerId` and asks a service
what that owner may do — the context holds identity, never permissions or secrets.

```ts file=roles.service.ts
import { Injectable } from "agboss";

/** Who may read what: the project's own store of roles. */
@Injectable()
export class RoleService {
  isAdmin(ownerId: string | undefined): Promise<boolean> {
    return Promise.resolve(ownerId === "usr_admin");
  }
}
```

```ts file=secure-data.tool.ts
import { ExecutionContext, Tool, type ToolHandler } from "agboss";
import { Text } from "agboss/dto";
import { RoleService } from "./roles.service.js";

export class SecureQuery {
  @Text({ prompt: "what to look up" }) query!: string;
}
export class SecureData {
  @Text() text!: string;
}

@Tool({
  name: "secure-data-tool",
  description: "Retrieves sensitive data; admins only",
  input: SecureQuery,
  output: SecureData,
  deps: [ExecutionContext, RoleService],
})
export class SecureDataTool implements ToolHandler<SecureQuery, SecureData> {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly roleService: RoleService,
  ) {}

  async run({ query }: SecureQuery): Promise<SecureData> {
    if (!(await this.roleService.isAdmin(this.executionContext.ownerId))) {
      return { text: "Access denied." };
    }
    return { text: `results for ${query} (key ${this.executionContext.step.idempotencyKey})` };
  }
}
```

A tool error or a denied call reaches the model as the call's result; the loop continues
([Agents](Agents)).

<!--
```ts file=data.workflow.ts
import { Agent, Workflow, WorkflowFinish, WorkflowStart, start } from "agboss";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "agboss/dto";
import { RoleService } from "./roles.service.js";
import { SecureDataTool } from "./secure-data.tool.js";
@WorkflowStart({ name: "data-workflow-start", description: "A request", input: WorkflowStartTextDto })
export class DataWorkflowStart {}
@WorkflowFinish({ name: "data-workflow-finish", description: "The answer", output: WorkflowFinishTextDto })
export class DataWorkflowFinish {}
@Agent({ name: "data-agent", description: "Looks data up", prompt: "Look it up.", model: "moonshotai/kimi-k2.6", tools: [SecureDataTool] })
export class DataAgent {}
@Workflow({
  name: "data-workflow",
  version: "1.0.0",
  providers: [RoleService],
  flow: [
    start(DataWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(DataAgent)
      .toFinish(DataWorkflowFinish),
  ],
})
export class DataWorkflow {}
```
-->

### Passing it in

<!-- snippet-context
import type { App } from "agboss";
import { DataWorkflowStart } from "./data.workflow.js";
declare const app: App;
declare const userId: string;
-->

```ts
const result = await app.execute(
  DataWorkflowStart,
  { text: "Process my confidential data" },
  {
    ownerId: userId, // the thread belongs to this user: executionContext.ownerId
    tenant: { tenantId: "acme" }, // the organization: executionContext.tenant.tenantId
  },
);
```

There is no untyped `metadata` or `executionContext` option (#261 PR 6): what a channel, a guardrail
or any other component needs of the execution it reads through its injected `ExecutionContext`
(the tenant, the owner, the project's own fields — `deps: [ExecutionContext]`; a channel's request
is made inside the paused step). An MCP session takes the values from its authenticated caller —
`createMcpService(app, Mcp).connect(transport, { tenant, execution, ownerId })` (`McpSessionOptions`,
`agboss/mcp`) — and so does an A2A call: `a2aHttpListener(app, { start, callerResolver })` asks
the host's **caller resolver** (an `@Injectable` in `providers`) for every request, before its body
is read — `A2ACallerResolution.resolved({ tenant, ownerId, execution })`, typed by the start's
application (a declared `TenantContext`'s values are required), or `.unauthenticated(…)` /
`.forbidden(…)`: a real `401` / `403`, nothing run, never the default tenant (#387,
[A2A](A2A#1-who-calls--the-caller-resolver)); a route of your own passes them to
`adapter.execute(Start, request, onEvent, { tenant, execution, ownerId })` (`A2ACallOptions`). A
resume through either takes the tenant's id; `adapter.cancel(threadId, caller)` cancels only the
caller's tenant's thread.

Tool arguments a channel shows (and `ExecutionOutput.pending[i].ask.arguments`) have the input DTO's `sensitive`
fields through their action — `replacePart(…)` as written, a token or a kind as `<field-name>`
(#120); the tool itself still gets them whole.

## In unit tests

A component created without the container takes `testExecutionContext({ … })` from
`agboss/testing` — a frozen `ExecutionContext` readable at any time, with defaults for what is not
given ([Testing](Testing)); `{ tenantContext, tenant, executionContext, execution, application: {
environment } }` set the levels, checked like at `execute`:

<!-- snippet-context
import { testExecutionContext, toolOf } from "agboss/testing";
import { RoleService } from "./roles.service.js";
import { SecureDataTool } from "./secure-data.tool.js";
-->

```ts
const tool = toolOf(
  new SecureDataTool(testExecutionContext({ ownerId: "usr_admin" }), new RoleService()),
);
const answer = await tool.invoke({ query: "salaries" });
```

<!-- snippet-context
import { testExecutionContext } from "agboss/testing";
import { ClinicTenantContext, UnitDirectoryService } from "./clinic.context.js";
-->

```ts
const { tenant } = testExecutionContext({
  tenantContext: ClinicTenantContext,
  tenant: { tenantId: "haifa-clinic", units: [{ unitId: "icu", name: "Intensive care" }] },
});
const unitName: string = new UnitDirectoryService(tenant).unitName("icu"); // "Intensive care"
```
