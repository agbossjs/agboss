# Context and Authorization

An execution has two kinds of data: the **state** it works on (the path scope, persisted by the
checkpointer — it survives steps, pauses and the next execution of the thread) and the **execution
context** — which execution and which step is running, and who the thread belongs to. Domain data
always come through a node's `input`; the context carries identity and execution metadata only.

## `ExecutionContext` (#280)

`ExecutionContext` is the one context of an execution. Any component — a tool, an action, a judge,
a service — takes it through its constructor, like every other dependency: `deps: [ExecutionContext]`
and a constructor parameter named `executionContext`. There is no `ctx` parameter anywhere: tools,
actions and judges get only their input.

| Field                     | What                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| `executionId`             | unique per execution, the same after a resume (`ExecutionOutput.runId`)                  |
| `threadId`                | the conversation (`ExecutionOutput.thread`)                                              |
| `ownerId`                 | from `execute(…, { owner })`: who the thread belongs to; `undefined` for an open thread  |
| `signal`                  | aborted by `app.cancel(thread)` or the caller's `signal`; in a tool call also at the tool's `timeoutMs` |
| `workflow`                | `{ type, name, version, startedVersion }` — the `@Workflow` class, its name, versions    |
| `step`                    | the step running now (below) — different in each parallel branch and each tool call      |
| `parent`, `root`, `depth` | the execution tree: one level until #263 (`parent` `undefined`, `root === this`, `1`)    |
| `executionOf(W)`          | the nearest execution of workflow `W` in the chain (this one included), else `undefined` |
| `itemIndex`               | the index of a child launched per item (#263); `undefined` otherwise                     |

`step`: `component` (`{ type, name }`), `nodeId` (the node's id in `result.path` and traces —
`critic-agent#2` for the second copy of a repeated target of a launch),
`visitNumber` (the pass through this node, from 1 — the counter `maxVisits` checks), `callId` (the
model's tool-call id while a tool call runs, else `undefined`), `itemIndex` (per-item launches,
#273), `copyNumber` (from 1, #273) and `idempotencyKey`:

```
${executionId}:${nodeId}:${visitNumber}[:${itemIndex}][:${callId}]
```

In a step `signal` is the execution's; in a tool call's frame it is the call's own —
`AbortSignal.any` of the execution's signal and a timer of the tool's `timeoutMs`, cleared when the
call ends (S45) — so a request passed that signal stops on a cancel and on the call's timeout.

One key per operation: every pass of a cycle, every item and every tool call has its own; a retry,
a judge's retry and a resume keep it, so an external service recognises the repeat. Pass it to the
service's own idempotency key ([Cancellation and idempotency](Saga-And-Cancellation)).

The injected object is not a snapshot: every read gives the current execution and step (one
`AsyncLocalStorage` frame per node visit and per tool call, closed when it ends), so it is safe in an
app-scoped component and in parallel branches. It is read-only and holds no input, no metadata and
no access to the container.

- **Outside an execution** — in a constructor at application start — a read throws
  `ExecutionContextUnavailableError` (`code: "context.unavailable"`), naming the class that read it:
  `AuditService read executionContext.executionId outside an execution.` Injecting it is always
  allowed; only reading it fails, never with `undefined`.
- **After its step ended** — a forgotten promise reading it once the tool call or the step returned —
  it throws the same error naming the ended step: `the execution context was read after its step
ended (payment-agent:1 tool call call_7f3a in execution 4f1c…)`. A tool call's frame closes while
  its agent goes on; a read never falls back to the agent's frame. What code already took out of the
  context (the `step` object, the `signal`) keeps working.

The tenant and the application levels above an execution (`executionContext.tenant`,
`ApplicationContext`) and project subclasses of `ExecutionContext` come with #261.

## Authorization in a tool

A thread created with an `owner` belongs to it: `execute` on that thread, `resume` and `cancel` with
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
  name: "secure_data",
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
    owner: userId, // the thread belongs to this user: executionContext.ownerId
    metadata: { requestId: "req_abc789" }, // for channels (ChannelRequest.metadata), not tools
  },
);
```

Tool arguments a channel shows (and `ExecutionOutput.pause.args`) have the input DTO's `sensitive`
fields masked as `***`; the tool itself still gets them whole.

## In unit tests

A component created without the container takes `testExecutionContext({ … })` from
`agboss/testing` — a frozen `ExecutionContext` readable at any time, with defaults for what is not
given ([Testing](Testing)):

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
