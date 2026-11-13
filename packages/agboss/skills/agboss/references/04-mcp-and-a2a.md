# 04 — MCP and A2A

Read this when an agent uses tools of an MCP server, when a workflow is offered to MCP clients, or
when one application calls another over A2A (agent-to-agent) or is called that way. Tools in general:
`03-components-di-and-lifecycle.md`; approvals: `05-channels-and-human-in-the-loop.md`.

| You want to…                                          | Use                                                                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| give an agent tools of an MCP server                  | `@McpServer` (`extends McpServerClient`) in `@Workflow({ mcp })` + `@McpTool` classes in the agent's `tools`  |
| let Claude Desktop / another agent call your workflow | `@McpExpose` + `createMcpService(app, Expose)` (`@agboss/core/mcp`)                                           |
| call a workflow of another AGBoss application         | `@A2AAgent({ target, input, output })` (`extends A2AClient<In, Out>`) in `providers`, injected into a `@Tool` |
| serve your workflow to A2A callers                    | `@A2AExpose` in `@Application({ exposes })` + `a2aHttpListener(app, { expose, callerResolver })`              |

## Using an MCP server

The server tools' DTOs — input and output of each one you use, one class per file:

```ts file=src/support/dto/issue-search.dto.ts
import { Text } from "@agboss/core/dto";

export class IssueSearchDto {
  @Text({ prompt: "words to search the issues for" })
  query!: string;
}
```

```ts file=src/support/dto/issue-hit.dto.ts
import { Text } from "@agboss/core/dto";

export class IssueHitDto {
  @Text({ prompt: "the issue's title" })
  title!: string;

  @Text({ prompt: "the issue's link" })
  url!: string;
}
```

```ts file=src/support/dto/issue-hits.dto.ts
import { ListOf } from "@agboss/core/dto";
import { IssueHitDto } from "./issue-hit.dto.js";

export class IssueHitsDto {
  @ListOf(IssueHitDto, { prompt: "the matching issues" })
  issues!: IssueHitDto[];
}
```

```ts file=src/support/mcp/issues.server.ts
// mcp/issues.server.ts — the server and the tools of it this workflow uses (checked at start)
import { McpServer, McpServerClient } from "@agboss/core/mcp";
import { IssueHitsDto } from "../dto/issue-hits.dto.js";
import { IssueSearchDto } from "../dto/issue-search.dto.js";

const tools = {
  search_issues: { input: IssueSearchDto, output: IssueHitsDto }, // the server's own tool name
};

@McpServer({
  name: "issues",
  transport: "http", // Streamable HTTP; or transport: "stdio" with command, args, env
  url: "https://mcp.issues.example/mcp",
  headers: { authorization: "ISSUES_MCP_TOKEN" }, // header → NAME of the env variable, never the value
  tools,
})
export class IssuesServer extends McpServerClient<typeof tools> {}
```

```ts file=src/support/mcp/search-issues.mcp.ts
// mcp/search-issues.mcp.ts — the tool the model sees; it calls the server tool, typed by `tools`
import { ExecutionContext, type ToolHandler } from "@agboss/core";
import { McpTool } from "@agboss/core/mcp";
import { kilobytes, seconds } from "@agboss/core/units";
import { IssueHitsDto } from "../dto/issue-hits.dto.js";
import { IssueSearchDto } from "../dto/issue-search.dto.js";
import { IssuesServer } from "./issues.server.js";

@McpTool({
  server: IssuesServer,
  name: "search-issues-tool",
  description: "Searches the issue tracker",
  input: IssueSearchDto,
  output: IssueHitsDto,
  timeout: seconds(10),
  maxResultSize: kilobytes(32),
  deps: [IssuesServer, ExecutionContext],
})
export class SearchIssuesTool implements ToolHandler<IssueSearchDto, IssueHitsDto> {
  constructor(
    private readonly issuesServer: IssuesServer,
    private readonly executionContext: ExecutionContext,
  ) {}

  run({ query }: IssueSearchDto): Promise<IssueHitsDto> {
    // name and arguments checked by the compiler; the signal aborts it on timeout or cancel
    return this.issuesServer.call("search_issues", { query }, this.executionContext.signal);
  }
}
```

- **Connections are the framework's**: every `@McpServer` of `@Workflow({ mcp: [...] })` is
  connected when the application starts and closed by `app.close()` — no lifecycle hook of yours.
  At start each declared server tool must exist with a compatible input schema, else the start fails
  naming it. Secrets are never in the decorator: `env: ["GITHUB_TOKEN"]` (stdio) and `headers`
  (http) name variables.
- **Names**: the `@McpTool`'s `name` ends with `-tool` (what the model sees); the server's own tool
  names (`search_issues`) stay as the server has them and only appear in `tools` and `call(…)`.
- **Everything a tool gets applies**: `timeout`, `maxResultSize`, `channel` (an approval before the
  call, reference 05), PII masking of arguments and results at the model boundary and block rules
  that reject the call (reference 07), `SpendRecorder`, `executionContext.step.idempotencyKey`.
- A server tool that answers plain text declares `output: PlainTextDto` (`{ text }`).
- Tests never start the server: `mcpOf(IssuesServer).thenReturn({ search_issues: () => (…) })` in
  `testWith`, `mcpServerStub(IssuesServer, handlers)` for a unit (reference 10).

## Calling another application over A2A

```ts file=src/support/dto/order-question.dto.ts
import { Text } from "@agboss/core/dto";

export class OrderQuestionDto {
  @Text({ prompt: "the question for the order desk" })
  question!: string;
}
```

```ts file=src/support/dto/order-desk-reply.dto.ts
import { Text } from "@agboss/core/dto";

export class OrderDeskReplyDto {
  @Text({ prompt: "the order desk's answer" })
  text!: string;
}
```

```ts file=src/support/a2a/order-desk.a2a-agent.ts
// a2a/order-desk.a2a-agent.ts — an A2A v1.0 agent as a declared contract (#809): whom it calls, what
// it sends, gets back and costs; per-call headers from the execution
import { ExecutionContext } from "@agboss/core";
import { A2AAgent, A2AClient } from "@agboss/core/a2a";
import { usd } from "@agboss/core/units";
import { OrderDeskReplyDto } from "../dto/order-desk-reply.dto.js";
import { OrderQuestionDto } from "../dto/order-question.dto.js";

@A2AAgent({
  name: "order-desk-a2a-agent",
  url: "https://orders.example/a2a", // its card: <url>/.well-known/agent-card.json
  target: { application: "orders-application", skill: "order-desk-workflow-start" },
  input: OrderQuestionDto, // the target skill's input
  output: OrderDeskReplyDto, // its finish's output
  price: usd(0.002), // per call: the step records the larger of it and a trusted peer's report
  deps: [ExecutionContext],
})
export class OrderDeskA2AAgent extends A2AClient<OrderQuestionDto, OrderDeskReplyDto> {
  constructor(private readonly executionContext: ExecutionContext) {
    super();
  }

  protected override getHeaders(): Promise<Record<string, string>> {
    // what the remote's caller resolver authenticates (a token, mTLS): never trusted from a body
    return Promise.resolve({ "x-tenant-id": this.executionContext.tenant.tenantId });
  }
}
```

```ts file=src/support/tools/ask-order-desk.tool.ts
// tools/ask-order-desk.tool.ts — an agent delegates to the remote workflow through a tool
import { ExecutionContext, Tool, type ToolHandler } from "@agboss/core";
import { seconds } from "@agboss/core/units";
import { OrderDeskReplyDto } from "../dto/order-desk-reply.dto.js";
import { OrderQuestionDto } from "../dto/order-question.dto.js";
import { OrderDeskA2AAgent } from "../a2a/order-desk.a2a-agent.js";

@Tool({
  name: "ask-order-desk-tool",
  description: "Asks the order desk about an order",
  input: OrderQuestionDto,
  output: OrderDeskReplyDto,
  timeout: seconds(60), // also the envelope's remaining time
  deps: [OrderDeskA2AAgent, ExecutionContext],
})
export class AskOrderDeskTool implements ToolHandler<OrderQuestionDto, OrderDeskReplyDto> {
  constructor(
    private readonly orderDeskA2AAgent: OrderDeskA2AAgent,
    private readonly executionContext: ExecutionContext,
  ) {}

  run(question: OrderQuestionDto): Promise<OrderDeskReplyDto> {
    // typed by the contract: the input and the output validated, the price recorded
    return this.orderDeskA2AAgent.execute(question, { signal: this.executionContext.signal });
  }
}
```

```ts file=src/support/agents/support/support.agent.ts
import { Agent } from "@agboss/core";
import { SearchIssuesTool } from "../../mcp/search-issues.mcp.js";
import { AskOrderDeskTool } from "../../tools/ask-order-desk.tool.js";

@Agent({
  name: "support-agent",
  description: "Answers from the issue tracker and the order desk",
  prompt: "Answer the question. Search issues with search-issues-tool; ask the order desk about orders.",
  model: "moonshotai/kimi-k2.6",
  tools: [SearchIssuesTool, AskOrderDeskTool],
  maxToolCalls: 5,
})
export class SupportAgent {}
```

Serving the workflow to A2A callers (below) takes a **caller resolver**: who calls, decided by the
host for each request — its tenant, the thread's owner, the execution's values. An ordinary
`@Injectable`, listed in `providers` and created by the container like any service:

```ts file=src/support/services/api-key-directory.service.ts
// services/api-key-directory.service.ts — the host's own service (a database, a KMS, …)
import { Injectable } from "@agboss/core";

export interface ApiKeyGrant {
  readonly clientId: string;
  readonly tenantId: string;
  readonly canAnswerPauses: boolean;
}

@Injectable()
export class ApiKeyDirectory {
  grantOf(apiKey: string): Promise<ApiKeyGrant | undefined> {
    return Promise.resolve(apiKey === "key-acme" ? { clientId: "client-acme", tenantId: "acme", canAnswerPauses: true } : undefined);
  }
}
```

```ts file=src/support/a2a/support.a2a-caller-resolver.ts
// a2a/support.a2a-caller-resolver.ts — who calls: decided by the host, the tenant never guessed
import { Injectable } from "@agboss/core";
import { A2ACallerResolution, A2AOperation, type A2ACallerRequest, type A2ACallerResolver } from "@agboss/core/a2a";
import type { SupportWorkflowStart } from "../workflows/support/support.workflow-start.js";
import { ApiKeyDirectory, type ApiKeyGrant } from "../services/api-key-directory.service.js";

@Injectable({ deps: [ApiKeyDirectory] }) // created by the container, never `new`
export class SupportA2aCallerResolver implements A2ACallerResolver<typeof SupportWorkflowStart> {
  constructor(private readonly apiKeyDirectory: ApiKeyDirectory) {}

  async resolveCaller(request: A2ACallerRequest): Promise<A2ACallerResolution<typeof SupportWorkflowStart>> {
    const header: string = request.http.headers.authorization ?? ""; // headers, socket, operation, task
    if (!header.startsWith("Bearer ")) {
      return A2ACallerResolution.unauthenticated({ reason: "no API key", challenge: 'Bearer realm="a2a"' });
    }
    const grant: ApiKeyGrant | undefined = await this.apiKeyDirectory.grantOf(header.slice("Bearer ".length));
    if (grant === undefined) return A2ACallerResolution.unauthenticated({ reason: "unknown API key" });
    const isResume = request.operation === A2AOperation.SendMessage && request.taskId !== undefined;
    if (isResume && !grant.canAnswerPauses) {
      return A2ACallerResolution.forbidden({ reason: "this key may not answer pauses" });
    }
    return A2ACallerResolution.resolved({ tenant: { tenantId: grant.tenantId }, ownerId: grant.clientId });
  }
}
```

The workflow — its start and finish beside it in `workflows/support/` —, what the application
serves over A2A, its budgets and the application:

```ts file=src/support/workflows/support/support.workflow-start.ts
import { WorkflowStart } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";

@WorkflowStart({ name: "support-workflow-start", description: "A question", input: WorkflowStartTextDto })
export class SupportWorkflowStart {}
```

```ts file=src/support/workflows/support/support.workflow-finish.ts
import { WorkflowFinish } from "@agboss/core";
import { WorkflowFinishTextDto } from "@agboss/core/dto";

@WorkflowFinish({ name: "support-workflow-finish", description: "The answer", output: WorkflowFinishTextDto })
export class SupportWorkflowFinish {}
```

```ts file=src/support/workflows/support/support.workflow.ts
import { Workflow, start } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { OrderDeskA2AAgent } from "../../a2a/order-desk.a2a-agent.js";
import { SupportA2aCallerResolver } from "../../a2a/support.a2a-caller-resolver.js";
import { SupportAgent } from "../../agents/support/support.agent.js";
import { IssuesServer } from "../../mcp/issues.server.js";
import { ApiKeyDirectory } from "../../services/api-key-directory.service.js";
import { SupportWorkflowFinish } from "./support.workflow-finish.js";
import { SupportWorkflowStart } from "./support.workflow-start.js";

@Workflow({
  name: "support-workflow",
  version: "1.0.0",
  flow: [
    start(SupportWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(SupportAgent)
      .toFinish(SupportWorkflowFinish),
  ],
  mcp: [IssuesServer], // the servers this workflow connects to
  // an A2A client and the caller resolver are providers like any service
  providers: [OrderDeskA2AAgent, ApiKeyDirectory, SupportA2aCallerResolver],
})
export class SupportWorkflow {}
```

```ts file=src/support/a2a/support.a2a-expose.ts
// what the application serves over A2A (#398 PR 3): the starts a caller may run
import { A2AExpose, A2ASecurity } from "@agboss/core/a2a";
import { SupportWorkflowStart } from "../workflows/support/support.workflow-start.js";

@A2AExpose({
  name: "support-a2a-expose",
  version: "1.0.0",
  description: "Answers support questions",
  exports: [SupportWorkflowStart],
  security: [A2ASecurity.bearer()], // the card's securitySchemes; the resolver enforces it
})
export class SupportA2AExpose {}
```

```ts file=src/support/budgets/application-daily.budget.ts
import { Budget, BudgetPeriod, BudgetScope, type BudgetHandler } from "@agboss/core";
import { usd, type Usd } from "@agboss/core/units";

@Budget({ name: "application-daily-budget", scope: BudgetScope.Application, period: BudgetPeriod.Day })
export class ApplicationDailyBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(5);
  }
}
```

```ts file=src/support/budgets/tenant-daily.budget.ts
import { Budget, BudgetPeriod, BudgetScope, type BudgetHandler } from "@agboss/core";
import { usd, type Usd } from "@agboss/core/units";

@Budget({ name: "tenant-daily-budget", scope: BudgetScope.Tenant, period: BudgetPeriod.Day })
export class TenantDailyBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(1);
  }
}
```

```ts file=src/support/budgets/execution.budget.ts
import { Budget, BudgetScope, type BudgetHandler } from "@agboss/core";
import { usd, type Usd } from "@agboss/core/units";

@Budget({ name: "execution-budget", scope: BudgetScope.Execution })
export class ExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(0.1);
  }
}
```

```ts file=src/support.application.ts
import { Application, EmptyEnvironment } from "@agboss/core";
import { SupportA2AExpose } from "./support/a2a/support.a2a-expose.js";
import { ApplicationDailyBudget } from "./support/budgets/application-daily.budget.js";
import { ExecutionBudget } from "./support/budgets/execution.budget.js";
import { TenantDailyBudget } from "./support/budgets/tenant-daily.budget.js";
import { SupportWorkflow } from "./support/workflows/support/support.workflow.js";

@Application({
  name: "support-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [SupportWorkflow],
  budgets: [ApplicationDailyBudget, TenantDailyBudget, ExecutionBudget],
  exposes: [SupportA2AExpose], // describe --json lists it among the exported contracts
})
export class SupportApplication {}
```

- `@A2AAgent({ name, url, target?, input?, output?, price?, mesh?, allowedOrigins?, deps })`
  (`A2AAgentConfig`; `target` an `A2ATarget { application?, skill?, finishes? }` — `skill` was `start`) on a class
  that `extends A2AClient<In, Out>` calls any A2A v1.0 agent (#809, on the official `@a2a-js/sdk`): the
  card is read from `<url>/.well-known/agent-card.json` on first use (`cardTtl`, 5 min) and checked — an
  A2A 1.0 interface (a v0.3-only card is `A2AProtocolError` naming its version), the skill
  (`[a2a.unknown-skill]`), an AGBoss peer's declared schemas against the DTOs (`[a2a.schema-mismatch]`),
  every interface on the `url`'s origin or `allowedOrigins` (else `A2AOriginError`, no request goes
  there; redirects elsewhere refused) — before anything is sent (`A2AContractError`).
  `execute(input, call?)` sends one data part (text for `WorkflowStartTextDto`) and returns the
  COMPLETED task's output, validated; FAILED / REJECTED is `A2ATaskFailedError` (an AGBoss peer's
  `limit.mesh-loop` / `limit.hops` the same limit error), CANCELED `A2ATaskCanceledError`,
  INPUT_REQUIRED `A2ATaskInterruptedError` (a remote pause is not a local one yet), a JSON-RPC error
  `A2AProtocolError` (codes only, never the agent's text). `send(message, call?)` (a text, `{ data }`
  or the parts) returns `A2ATaskResult { task, message, text, data, peer }` — an interrupted task too,
  continued with `reply(taskId, answer)`; `getTask(taskId)`, `cancel(taskId)` (was `cancel(threadId)`),
  `agentCard()`. A call that gives nothing usable (a COMPLETED task without output) is
  `A2ARemoteCallError` (was `A2ARemoteError`). Without both DTOs (or `new A2AClient({ url, contract: { skill, input, output } })`,
  `A2AClientContract`) `execute` throws `[a2a.no-contract]`.
- The accept round trip runs through `OutboundCalls` inside an execution: `SendMessage` with
  `returnImmediately`, a messageId derived from the step's key. A send of unknown outcome (no answer, a
  5xx) is resent with the same messageId only to an **AGBoss peer** (its card's mesh extension declares
  `idempotencyRetention`, `NotSentTrust.KeyReplay`); to a **foreign peer** it is never resent:
  `OutboundCallUnreconciledError`. Two calls of one step with other messages need `call.key`
  (`[a2a.repeated-call]`; 1–40 of `[A-Za-z0-9._-]`). The peer's trust is recorded with the call (a
  card that changed since is never resent to); a foreign reply counts as arrived only when the
  task's history holds its messageId; a step of no composed application (a unit runner's) is
  `[a2a.outside-application]` — mock the client there; the price is charged at the accept. Then
  the task is waited for — `SubscribeToTask` when the card streams (a
  dropped stream opened again), else `GetTask` polled on the `Clock` — up to the execution's deadline or
  `call.timeout`: then a best-effort `CancelTask` and `A2ACallDeadlineError`.
- The mesh rides the call as the extension `https://agboss.dev/a2a/mesh/v1`: `mesh: A2AMesh.Required`
  (the default with a `target.application`; a card without it is `A2AMeshUnsupportedError`, nothing
  sent) or `IfSupported`. The envelope (call chain, budget and deadline left, signed only with an
  `audience` — the target application) goes in `message.metadata`; a loop is refused before sending.
- Names: `name` ends with `-a2a-agent`, the class with `A2AAgent` (`[name.kind-suffix]`). Its file is
  `a2a/<name>.a2a-agent.ts`.
- `call.onEvent` gets each event of the remote task while the call waits (`A2AStreamEvent`).
- The remote's cost: `price` per call, and — from a trusted peer (below) — its signed run report;
  the calling tool's spend records the larger (`a2a:<target application>`), so the budgets count it.
  Pass `executionContext.signal` so a cancel or a timeout aborts the HTTP call.
- `agboss describe --json` lists every `@A2AAgent` under `application.contracts.imports` (target,
  `usedBy`, input and output with their `schemaHash`, price) and every listed `@A2AExpose` /
  `@McpExpose` under `exports` (an A2A export by its `skill` — the start's name). Save each
  neighbour's as a file and run `npx agboss check --federation snapshots/`: no network, every
  consumed contract whose target is among the snapshots compared field by field — an `@A2AAgent`
  is paired by `(target.application, target.skill)` with the export `skill` of that application,
  an MCP server's `target: { application, expose }` the same way —
  `[federation.missing-target]`, `[federation.incompatible-schema]`, each with the consumer's
  workflows it affects. An `@A2AAgent` without `target.application` (a foreign A2A agent, typed or
  not) is listed with `foreign: true` — `input` / `output` `null` when untyped — and never
  compared: no pairing, no `[federation.missing-target]`. A snapshot saved by 0.1.0 (exports and
  targets named `start`) is still read.

## Exposing a workflow

Over MCP — the workflow's tools and starts become MCP tools; a start runs `app.execute`, and with any
start exported `resume_workflow` (`app.resume`) is offered too:

```ts file=src/support/mcp/support.expose.ts
import { McpExpose } from "@agboss/core/mcp";
import { SupportWorkflowStart } from "../workflows/support/support.workflow-start.js";
import { SearchIssuesTool } from "./search-issues.mcp.js";

@McpExpose({
  name: "support-mcp",
  version: "1.0.0",
  exports: [SearchIssuesTool, SupportWorkflowStart], // tools of the workflow, and its starts
})
export class SupportMcp {}
```

<!-- snippet-context
import { createApp } from "@agboss/core";
import { SupportApplication } from "./src/support.application.js";
import { SupportMcp } from "./src/support/mcp/support.expose.js";
-->

```ts
// server.ts — local clients over stdio; for HTTP: service.handleSse(res, "/mcp/messages", session)
// and service.handleMessage(req, res, sessionId) in your HTTP framework
import { createMcpService } from "@agboss/core/mcp";

const app = await createApp(SupportApplication);
const service = createMcpService(app, SupportMcp);
await service.connectStdio(); // serves until stdin closes
```

Over A2A — an `@A2AExpose({ name, version, description, exports, skills?, provider?, security? })`
(`-a2a-expose`, a `…A2AExpose` class; its `exports` starts of the application's workflows,
`[application.expose-unknown-start]`) listed in `@Application({ exposes })` (else `a2aHttpListener`
throws `[application.expose-unlisted]`) is an **A2A v1.0 agent** (#808,
https://a2a-protocol.org/v1.0.0/specification/): its Agent Card at
`<base>/.well-known/agent-card.json` (one skill per exported start, its id the start's name, tags
default the application's name; `capabilities.streaming`; the skills extension
`https://agboss.dev/a2a/skills/v1` with each skill's input and finishes' JSON Schemas;
`securitySchemes` from `security`; one JSONRPC 1.0 interface at `publicUrl` + `base`) and the
JSON-RPC binding at `POST <base>`: `SendMessage` (blocking, or `configuration.returnImmediately`),
`SendStreamingMessage`, `GetTask`, `ListTasks`, `CancelTask`, `SubscribeToTask`; push methods are
`-32003`, a missing or `0.3` `A2A-Version` `-32009`. A message names its skill in
`metadata["https://agboss.dev/a2a/skills/v1"].skill` (optional with one export, or a `defaultSkill`); its input is text
parts for a `WorkflowStartTextDto` start, else one `data` part, checked before anything is kept
(`-32602`). Each task is one root execution under the task's id, kept in `A2ATaskRepository`: a
message resent with the same `messageId` gets the same task, never a second run — on every
instance when the store is shared: on PostgreSQL, MongoDB or SQLite leases the application lists
`PostgresA2ATaskRepository`, `MongoA2ATaskRepository` or `SqliteA2ATaskRepository`, else it does not
assemble (`[a2a.task-store-not-shared]`; Redis keeps no A2A tasks); `ListTasks` gives `totalSize`,
every task its filters match; a task outlives
its connection (a disconnect never cancels it); `CancelTask` cancels that task only, also before
it started. A run at a pause its caller answers is `TASK_STATE_INPUT_REQUIRED` (its pauses in the
status message); a follow-up `SendMessage` with the same `taskId` answers it — one `data` part
`{ pauseId?, decision }` or a text reply. A pause only its channel answers is
`TASK_STATE_WORKING`, "awaiting <channel> out of band". A failure is `TASK_STATE_FAILED` with its
stable code and that code's fixed text, never the error's own. The listener is built from the
application: its resolver comes from the container (listed in the application's or a workflow's
`providers`, else `a2aHttpListener` throws `[a2a.caller-resolver-not-listed]`), and every request's
caller is resolved after its body is read (`maxBodySize`, default 1 MB, else `413`) and decoded for
its `operation` and `taskId` only — nothing of it acted on before the resolver decides:

<!-- snippet-context
import { createApp } from "@agboss/core";
import { SupportApplication } from "./src/support.application.js";
import { SupportA2AExpose } from "./src/support/a2a/support.a2a-expose.js";
import { SupportA2aCallerResolver } from "./src/support/a2a/support.a2a-caller-resolver.js";
-->

```ts
import { createServer } from "node:http";
import { a2aHttpListener } from "@agboss/core/a2a";

const app = await createApp(SupportApplication, { env: "prod" });
createServer(
  a2aHttpListener(app, {
    expose: SupportA2AExpose, // listed in @Application({ exposes })
    callerResolver: SupportA2aCallerResolver, // the class: its instance is the container's
    publicUrl: "https://support.example", // where callers reach it: the card's interface URL
    base: "/a2a",
  }),
).listen(8080);
```

| The resolver returns                                           | The caller gets                                                                                     |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `A2ACallerResolution.resolved({ tenant, ownerId, execution })` | the operation, for that tenant and owner (its tasks only; a context id is the tenant's own)         |
| `.unauthenticated({ reason, challenge? })`                     | `401`, `WWW-Authenticate: <challenge>`, `{ "code": "a2a.caller-unauthenticated", "error": reason }` |
| `.forbidden({ reason })`                                       | `403`, `{ "code": "a2a.caller-forbidden", "error": reason }`                                        |
| it throws                                                      | `500`, `{ "code": "a2a.caller-resolution-failed" }` — never the error's text                        |

- A refused request runs nothing: no `onExecutionStart`, no `onExecutionRejected`, no record — and a
  streaming caller gets the real status, not an event stream. `A2AClient.send` throws
  `A2ACallerRejectedError` (`code` `a2a.caller-rejected`, `httpStatus`, the server's `wireCode`) on a
  `401` / `403`.
- `resolved({ … })` is typed by the start's application: with a declared `TenantContext` its values
  are required. A single-tenant host returns `A2ACallerResolution.resolved({})` — never implied.
- An answer is built only by `A2ACallerResolution` (branded: a plain object does not compile).
- A caller that disconnects never cancels its task: it runs on, and `GetTask` / `SubscribeToTask`
  read it. `maxTaskDuration` gives every task an execution deadline.
- The names: `A2AApp` (what the listener takes of `App`), `A2AHttpListenerOptions`, `A2ACaller`,
  `A2ACallerRequest`, `A2AOperation`, `A2ACallerResolutionKind`, `ResolvedA2ACallerResolution`,
  `RejectedA2ACallerResolution`, `A2ACallerUnauthenticatedOptions`, `A2ACallerForbiddenOptions`.

### Direct message replies (#860)

A skill that needs no task — a lookup, a classification — answers `SendMessage` with a `Message`
directly: `reply: A2AReply.Message` in `@A2AExpose({ skills })`. `defaultSkill` is the skill a
message that names none runs (a foreign caller that knows nothing of the skills extension):

<!-- snippet-context
import { WorkflowStart } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { SupportWorkflowStart } from "./src/support/workflows/support/support.workflow-start.js";
@WorkflowStart({ name: "lookup-workflow-start", description: "A lookup", input: WorkflowStartTextDto })
class LookupWorkflowStart {}
-->

```ts
import { A2AExpose, A2AReply } from "@agboss/core/a2a";

@A2AExpose({
  name: "support-a2a-expose",
  version: "1.1.0",
  description: "Answers support questions",
  exports: [SupportWorkflowStart, LookupWorkflowStart],
  skills: {
    "lookup-workflow-start": { reply: A2AReply.Message, tags: ["lookup"] }, // a Message, no task
    "support-workflow-start": { tags: ["support"] },
  },
  defaultSkill: LookupWorkflowStart,
})
export class LookupA2AExpose {}
```

- The workflow must be stateless, checked at assembly on every node: no pause (`[a2a.message-skill-pause]`),
  no fenced effect, `OutboundCalls` or `@A2AAgent` among its `deps` at any depth (`-effect`), only
  `@Tool({ readOnly: true })` tools (`-tool`), no compensation (`-compensation`), no child workflow
  (`-child`); a `reply` set for a start the expose does not export, or a `defaultSkill` that is no
  export, is `[a2a.unknown-skill-option]`.
- `returnImmediately` is ignored; `SendStreamingMessage` answers one frame, the message; `GetTask` or a
  follow-up naming it is `-32001`.
- One `messageId` is one execution across both reply modes: the reply is kept in
  `A2ADirectMessageRepository` (in memory by default; `SqliteA2ADirectMessageRepository`, the
  PostgreSQL and MongoDB ones; the suite `a2aDirectMessageContract`) for `retention.a2aMessages`
  (default `minutes(15)`, published as the card's `messageIdempotencyRetention`); a resend within it
  gets the kept reply, one racing the first waits for it, another content under the id is
  `-32602 a2a.message-id-reused`. The store must be on the task store's backend
  (`[a2a.message-store-not-shared]`). A model skill whose instance died mid-call records one call of
  unknown cost (`CostSource.Unknown`) and is never run again by recovery; a later resend runs it once.

### File parts (#859)

A start's input or a finish's output may hold files: an `A2AFileDto` field (`@Nested(A2AFileDto)`, or
`@ListOf(A2AFileDto)`) is filled from `raw` (inline bytes) or `url` parts of the message — never from
a data part (`-32602 a2a.file-field-in-data`) — and a finish's file fields leave as file parts of its
artifact. A step reads and writes them through `A2AFiles` (`read`, `save`, `fromUrl`):

<!-- snippet-context
import { Injectable } from "@agboss/core";
import { A2AFileDto, A2AFiles } from "@agboss/core/a2a";
import { Nested, Text } from "@agboss/core/dto";
-->

```ts
export class ReviewRequestDto {
  @Nested(A2AFileDto, { prompt: "the document to review" })
  document!: A2AFileDto;

  @Text({ prompt: "a note to the reviewer", optional: true })
  note?: string;
}

@Injectable({ deps: [A2AFiles] })
export class DocumentReader {
  constructor(private readonly a2aFiles: A2AFiles) {}

  async report(request: ReviewRequestDto): Promise<A2AFileDto> {
    const bytes = await this.a2aFiles.read(request.document); // checked against its sha256
    return this.a2aFiles.save({
      bytes: new TextEncoder().encode(`read ${String(bytes.byteLength)} bytes`),
      mediaType: "text/plain",
      filename: "report.txt",
    });
  }
}
```

- A `url` part is fetched once, at the admission, by the server — never by a step: `https:` only, on
  `@Application({ a2aFiles: { allowedFileOrigins } })`, three redirects at most, no special-purpose
  address (the SSRF guard), bounded by `a2aHttpListener`'s `fileFetchTimeout`; a refusal is `-32602`
  (`a2a.file-origin-denied`, `a2a.file-fetch-failed`, …) before anything runs. Each file's bytes are
  checked against its declared media type (the header and the magic bytes), and its size and count
  against `@A2AExpose({ skills: { [id]: { files } } })` over `@Application({ a2aFiles })`.
- Bytes ride inline in the task's records up to 64 KB (above it with no store listed:
  `[a2a.inline-files-without-store]`, a warning; above 256 KB `[a2a.file-store-required]`); with an
  `A2AFileRepository` listed (`InMemoryA2AFileRepository`, `LocalDiskA2AFileRepository`,
  `S3A2AFileRepository`; the suite `a2aFileContract`) they are kept under the task, which on leases
  the instances share needs a store they all reach (`[a2a.file-store-not-shared]`).
- A task's files are kept while the task waits — a paused `INPUT_REQUIRED` task however long — and
  removed `retention.a2aFiles` after it is over (default `retention.a2aTasks`).
- The card names a skill's file fields in the skills extension (`files`, `outputFiles`), never in a
  data schema (`@A2AExpose({ cardFileFields })`). The client sends and reads files with
  `A2AClientFile.fromBytes` / `.fromUrl` and `downloadFile`.

### What an A2A server keeps

| Store                        | Holds                                           | Retention (default)           | Built in                                                                                                |
| ---------------------------- | ----------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------- |
| `A2ATaskRepository`          | one task per root execution, its messages' ids  | `a2aTasks` (`hours(24)`)      | in memory, `SqliteA2ATaskRepository`, `@agboss/postgres`, `@agboss/mongodb`; `a2aTaskContract`          |
| `A2ADirectMessageRepository` | a direct reply, by `(tenant, owner, messageId)` | `a2aMessages` (`minutes(15)`) | in memory, `SqliteA2ADirectMessageRepository`, PostgreSQL, MongoDB; `a2aDirectMessageContract`          |
| `A2AFileRepository`          | a task's files                                  | `a2aFiles` (`a2aTasks`)       | inline (none listed), in memory, `LocalDiskA2AFileRepository`, `S3A2AFileRepository`; `a2aFileContract` |

`@Application({ retention: { a2aTasks, a2aMessages, a2aFiles } })` sets them; an unfinished task is
never removed, and `a2aTasks` is how long a `messageId` is remembered after its task ended. An
application whose instances share leases (any backend but `in-memory`) lists a task store, a message
store (when a skill replies directly) and a file store (above 256 KB) they share, else it does not
assemble: `[a2a.task-store-not-shared]`, `[a2a.message-store-not-shared]`,
`[a2a.file-store-not-shared]`.

### The assembly rules of an A2A side

| Rule                                                                                                     | When                                                                                       |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `[a2a.expose-description-required]`                                                                      | an `@A2AExpose` with a blank `description` (the card's)                                    |
| `[a2a.skill-tags]` (warning)                                                                             | an exported skill with no `tags` (the card falls back to the application's name)           |
| `[a2a.unpriced-foreign-peer]` (warning)                                                                  | an `@A2AAgent` without `target.application` and without `price`: its spend is invisible    |
| `[a2a.task-store-not-shared]`                                                                            | shared leases, a task store that is not (above)                                            |
| `[a2a.file-store-required]`, `[a2a.file-store-not-shared]`, `[a2a.inline-files-without-store]` (warning) | where files may live (above)                                                               |
| `[a2a.message-skill-*]`, `[a2a.message-store-not-shared]`, `[a2a.unknown-skill-option]`                  | a direct reply (above)                                                                     |
| `[a2a.unknown-finish]`, `[a2a.nested-file-field]`, `[a2a.file-options-invalid]`                          | `target.finishes`; a file below the top level of a DTO; a size or media type of `a2aFiles` |

A warning is an error under `agboss check --strict`; every code is in reference 11.

### A resend whose reply was lost (#939)

A message resent with the same `messageId` is told apart by its **kept message**, not by the task's
state. A follow-up whose answer was taken but whose reply was lost (a failed write, a crash) and
whose task has finished since gets the task as it is on the resend — never `-32004 a2a.task-over`,
and nothing is charged again; a new message to a finished task is `a2a.task-over`. A follow-up to a
pause that closed (cancelled, withdrawn, ended with its tree) is `-32004 a2a.pause-closed` with its
`reason` and `closedAt`.

Tests: the `a2aServer({ expose, callerResolver })` fixture of `testWith` (an `A2AServerFixture`)
serves the test's `app` on `127.0.0.1:0` and returns an `A2ATestServer` — `{ url }` for `new
A2AClient({ url, headers })`; the loopback is open for it (no `allowNetwork`), it closes at the
test's end, and `override(ApiKeyDirectory, …)` replaces the resolver's services like any other
(reference 10):

```ts file=tests/support/a2a/support.a2a-caller-resolver.test.ts
import { expect } from "vitest";
import { Injectable } from "@agboss/core";
import { override, testWith } from "@agboss/core/testing";
import { ApiKeyDirectory, type ApiKeyGrant } from "../../../src/support/services/api-key-directory.service.js";
import { SupportA2aCallerResolver } from "../../../src/support/a2a/support.a2a-caller-resolver.js";
import { SupportA2AExpose } from "../../../src/support/a2a/support.a2a-expose.js";
import { SupportAgent } from "../../../src/support/agents/support/support.agent.js";
import { SupportApplication } from "../../../src/support.application.js";

@Injectable()
class NoKeysDirectory extends ApiKeyDirectory {
  override grantOf(): Promise<ApiKeyGrant | undefined> {
    return Promise.resolve(undefined); // every key unknown
  }
}

const test = testWith(SupportApplication, { overrides: [override(ApiKeyDirectory, NoKeysDirectory)] });

test("an unknown key is 401 and never runs", async ({ a2aServer, mockLlm }) => {
  const { url } = await a2aServer({ expose: SupportA2AExpose, callerResolver: SupportA2aCallerResolver });

  // any A2A v1.0 client calls the listener; a plain JSON-RPC `SendMessage` is the smallest one
  const sent = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "a2a-version": "1.0", authorization: "Bearer key-x" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "SendMessage",
      params: { message: { messageId: "m-1", role: "ROLE_USER", parts: [{ text: "hi" }] } },
    }),
  });

  expect(sent.status).toBe(401);
  expect(await sent.json()).toMatchObject({ code: "a2a.caller-unauthenticated" });
  expect(mockLlm(SupportAgent)).toHaveBeenCalledTimes(0);
});
```

## The mesh: call chains, hops and loops (#398)

AGBoss applications calling each other — over A2A (`A2AClient` → `a2aHttpListener`) or MCP (an
`@McpServer` → `createMcpService`) — are a mesh. Every call made **inside an execution** carries,
without any code of yours:

- the **envelope** (`MeshEnvelope`: `schema`, `issuer`, `origin` — `MeshOrigin` with its
  `MeshOriginStep` —, `callChain` of `MeshHop`s, each a `MeshEntry` plus its root `executionId`): the
  `message.metadata["https://agboss.dev/a2a/mesh/v1"].envelope` of the A2A `SendMessage` (the mesh
  extension, below), `_meta["agboss.dev/mesh"]` over MCP (a JWS — unsecured, `alg: "none"`, or
  signed, below); ids only — no `ownerId`, no `tenantId`, no input values;
- a W3C `traceparent` (header / `_meta.traceparent`): the caller's trace continued;
- over MCP `_meta.callId` = `executionContext.step.idempotencyKey`, so an AGBoss MCP server answers
  a repeated call as the same one; over A2A the step's key is the message's `messageId`.

Outside an execution (a script's `new A2AClient(…)`) nothing is sent. The receiver reads the
envelope into `A2ACallerRequest.envelope` for your resolver — a **claim** (unless signed by a
trusted peer, below): never take a tenant from it. A malformed envelope is ignored (the request runs as one
without). What it does apply is the chain, before anything runs:

| The chain the request arrives with                            | The receiver answers                                                                                                                                                           |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| already passed through its own application and start (a loop) | MCP `409 { "code": "limit.mesh-loop", "error", "details": { entry, chain } }`; A2A a `REJECTED` task, nothing run, the code and details in `status.message.metadata[mesh uri]` |
| as long as its `@Application({ maxMeshHops })` (default 8)    | MCP `409 { "code": "limit.hops", "error", "details": { maxMeshHops, hops, … } }`; A2A the same `REJECTED` task                                                                 |
| anything else                                                 | the run, whose own calls carry the chain on with its hop added                                                                                                                 |

On the caller `A2AClient` rethrows them typed — `MeshLoopDetectedError` / `HopsLimitExceededError`,
both `LimitExceededError`s — from the `REJECTED` / `FAILED` task's code and details, and so does an
MCP error result with `_meta["agboss.dev/error"]`. A tool that meets one
**fails its step** (the model never reads it: retrying a loop loops again); take it on the path:

<!-- snippet-context
import { Agent, MeshLoopDetectedError, Workflow, WorkflowFinish, WorkflowStart, start, toFinish } from "@agboss/core";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "@agboss/core/dto";
@Agent({ name: "orders-agent", description: "Orders", prompt: "Answer.", model: "moonshotai/kimi-k2.6" })
export class OrdersAgent {}
@WorkflowStart({ name: "orders-workflow-start", description: "A question", input: WorkflowStartTextDto })
export class OrdersWorkflowStart {}
@WorkflowFinish({ name: "orders-workflow-finish", description: "The answer", output: WorkflowFinishTextDto })
export class OrdersWorkflowFinish {}
@WorkflowFinish({ name: "looped-workflow-finish", description: "Handed back", output: WorkflowStartTextDto })
export class LoopedWorkflowFinish {}
-->

```ts file=orders/src/workflows/orders/orders.workflow.ts
@Workflow({
  name: "orders-workflow",
  version: "1.0.0",
  flow: [
    start(OrdersWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(OrdersAgent) // its tool calls the billing application over A2A
      .onError(
        MeshLoopDetectedError, // billing called back into orders-workflow-start
        toFinish(LoopedWorkflowFinish),
      )
      .toFinish(OrdersWorkflowFinish),
  ],
})
export class OrdersWorkflow {}
```

- A loop is the same `(application, skill)` twice in one chain — always, whatever the depth; another
  start of the same application is not one. An exported MCP tool is an entry like a start.
- `maxMeshHops` counts applications: a chain that already lists `maxMeshHops` of them is refused
  (`hops` = the chain + the receiver). `[limits.max-mesh-hops-invalid]` for anything but a whole
  number from 1.

### Trusted peers: signed envelopes (#398 PR 2)

An application that names its keys (`@Application({ mesh })`, `MeshOptions` with its `MeshPeer`s)
signs every envelope it sends (JWS `EdDSA`, Ed25519) and every
run report it answers with; its `peers` are the applications whose signatures it checks. Keys are
PEM in environment fields, named by field like a `@ModelProvider`'s `apiKey`: the private key a
`Secret` (PKCS #8), a peer's public key a plain text field (SPKI) — it is public.

<!-- snippet-context
import type { Secret } from "@agboss/core";
-->

```ts file=billing/src/environments/billing.environment.ts
// the contract
export class BillingEnvironment {
  meshSigningKey!: Secret; // secret("MESH_SIGNING_KEY") in each environment
  ordersPublicKey!: string; // env("ORDERS_PUBLIC_KEY")
}
```

<!-- snippet-context
import { Application } from "@agboss/core";
import { BillingEnvironment } from "./environments/billing.environment.js";
export class BillingWorkflow {} // a @Workflow of its own
-->

```ts file=billing/src/billing.application.ts
@Application({
  name: "billing-application",
  version: "1.0.0",
  environment: BillingEnvironment,
  workflows: [BillingWorkflow],
  mesh: {
    signingKey: "meshSigningKey",
    peers: [{ application: "orders-application", verifyKey: "ordersPublicKey" }],
  },
})
export class BillingApplication {}
```

These checks run where the envelope is read: an MCP call's `_meta["agboss.dev/mesh"]`, and an A2A
`SendMessage`'s `message.metadata["https://agboss.dev/a2a/mesh/v1"].envelope` (#810), before the
caller resolver: the audience first, then a known issuer's signature, replay window and the
message's body hash — a refusal is `401 { code }` and nothing runs. A message with no envelope, or a
call without the extension, runs untrusted (still deduplicated by `messageId`). The extension is
specified at https://agboss.dev/a2a/mesh/v1: the Agent Card declares it (`params.idempotencyRetention`
= `retention.a2aTasks`, `messageIdempotencyRetention` = `retention.a2aMessages`), a receiver that
activated it echoes it in its answer's `A2A-Extensions`, and a caller that gets no echo treats the
call as one without the mesh (`mesh: false` in the tool call's record).

A request is **trusted** only when both hold: the transport's caller names its `peer`
(`A2ACallerResolution.resolved({ …, peer: "orders-application" })` — what your transport proved,
mTLS or a token) and the envelope carries that peer's valid signature (`signedBy`). Before the
resolver the listener checks a signed envelope of a known issuer — its signature and its
`issuedAt` + `expiresIn` (60 s) on the `Clock` — and refuses a bad one with `401`
`mesh.signature-invalid` / `mesh.envelope-expired`; a trusted one must carry the body it signed
(`bodyHash`, else `401 mesh.body-mismatch`). Over MCP, `createMcpService(app, X).connect(transport, { peer })` names
the session's peer. A test signs as a peer with `signedMeshEnvelope({ issuer, audience?,
signingKey, body, issuedAt, origin, callChain, budget?, deadline? })` (`@agboss/core/testing`,
#521) — the framework's own encoder, the very header a real client sends for that call.

What a trusted request gets — never an untrusted one:

| From the caller                   | The receiver                                                                                                                                                                                                                             |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `budget.remaining`                | one more execution budget, `caller-budget`: it only lowers its own (`BudgetExceededError`)                                                                                                                                               |
| `deadline.remaining`              | the execution's deadline (`DeadlineExceededError`, `limit.deadline`)                                                                                                                                                                     |
| `origin` (and the chain's length) | `executionContext.origin`, the record's `origin` and every observer event's, its resumes' too (`ExecutionOrigin`)                                                                                                                        |
| `origin.step.idempotencyKey`      | dedupe: over MCP `MeshRequestRepository` — a repeat gets the kept answer, one in flight an error result `mesh.request-in-progress` (by `_meta.callId`); over A2A the task / message stores, by `messageId` (every caller, signed or not) |

Its answer carries a run report (`MeshRunReport`: `issuer`, `executionId`, `spend`, `bodyHash`)
signed by the receiver — `task.metadata[mesh uri].report` over A2A (a direct `Message` reply's in
`message.metadata[mesh uri].report`), `_meta["agboss.dev/report"]` over MCP. A caller that verifies it with its `mesh.peers` key records the reported
spend as `a2a:<issuer>` / `mcp:<issuer>` in the calling tool's spend and the remote execution in
`ToolCallRecord.remote` (`ToolCallRemote`: `application`, `executionId`); an unverified report is
ignored. The deadline is yours too: `app.execute(Start, input, { deadline: seconds(30) })` — the
smaller of it and a trusted caller's, checked before every step and model call (a call in flight is
not cut). `A2AClient.cancel(taskId)` sends A2A `CancelTask` for that task only (#809).

- `MeshRequestRepository` is infrastructure (in memory; `SqliteMeshRequestRepository` shares it
  between instances), kept `retention.meshAnswers` (default `minutes(30)`), then removed by the
  recovery sweep. Only trusted MCP requests are deduplicated: a `tools/call` by its `_meta.callId` (the AGBoss client sends
  the step's key) — a repeat gets the kept result, one in flight an error result with
  `_meta["agboss.dev/error"]` `mesh.request-in-progress`.
- `[mesh.signing-key-missing]`, `[mesh.unknown-peer-key]`, `[mesh.duplicate-peer]` at assembly;
  `[mesh.invalid-key] <field> holds no …` at start (never the value).
- The envelope's `audience` is the client's `target.application` (an `@McpServer({ target: {
application, expose } })`'s over MCP): a receiver of another name refuses it, signed or not —
  `401 mesh.audience-mismatch` (an MCP error result with that code), nothing runs; on the caller
  the tool fails with `[mesh.audience-mismatch] …`.

## Errors and fixes

| You see                                                        | Fix                                                                                                  |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| the start fails: `search_issues: tool not found on the server` | the `tools` key must be the server's exact tool name                                                 |
| the start fails: `… input: …` schema differences               | make the input DTO match the server tool's input schema                                              |
| `MCP server "issues" needs env variable ISSUES_MCP_TOKEN`      | set the variable; the decorator only names it                                                        |
| `[name.kind-suffix]` on an `@McpTool`                          | name it `<what>-tool`                                                                                |
| `[tool.duplicate-name]`                                        | two tools a model sees share a name (local, MCP, `search-<rag>-tool`, `answer-<dto>`)                |
| `A2ATaskInterruptedError` (`input-required`)                   | the remote task waits for input: use `send` and `reply(taskId, …)`, or answer it remotely            |
| `A2AProtocolError … declares A2A 0.3`                          | the agent speaks A2A v0.3 only: 0.1.1 calls v1.0 agents                                              |
| `A2AOriginError` (`a2a.origin-refused`)                        | the card names an interface on another origin: list it in `allowedOrigins` if it is the agent's      |
| `A2AMeshUnsupportedError`                                      | the AGBoss target does not declare the mesh: `mesh: A2AMesh.IfSupported`, or fix its card            |
| `OutboundCallUnreconciledError` (`foreign A2A peer`)           | a send to a foreign agent got no answer: check the agent, then decide (`app.pendingOutboundCallsOf`) |
| `[a2a.no-url]`                                                 | the client class lacks `@A2AAgent({ url })`                                                          |
| `[a2a.no-contract]`                                            | `execute` on a client without `@A2AAgent({ input, output })`: declare them, or use `send`            |
| `[application.expose-unlisted]`                                | list the `@A2AExpose` in `@Application({ exposes })`                                                 |
| `400 a2a.unknown-start`                                        | name an exported start (`target.start`), or export only one                                          |
| `[mesh.audience-mismatch] …`                                   | the client's `target.application` is not the application at its `url`                                |
| `mesh.audience-missing`                                        | a signed envelope names no application: sign only with an audience (`target.application`)            |
| `[a2a.caller-resolver-not-listed] … is not listed`             | list the resolver in `@Application({ providers })` or a `@Workflow({ providers })`                   |
| `A2ACallerRejectedError … (401 a2a.caller-unauthenticated)`    | the server's resolver refused the client's credentials: check its `headers`                          |
| `MeshLoopDetectedError` (`limit.mesh-loop`)                    | two applications call each other back: break the cycle, or `.onError` it to a finish                 |
| `HopsLimitExceededError` (`limit.hops`)                        | the call chain is longer than the receiver's `maxMeshHops`: shorten it or raise it                   |
| `401 mesh.signature-invalid` / `mesh.envelope-expired`         | the caller signs with another key than its peer entry, or the clocks differ by > 30 s                |
| `DeadlineExceededError` (`limit.deadline`)                     | the execution (or its trusted caller) ran out of time: raise `deadline`, or `.onError`               |

## Pitfalls

- An MCP connection opened by hand in a service's `onStart`: declare the `@McpServer` instead, so the
  start checks its tools and tests stub it.
- Secrets in `@McpServer({ headers })` values or `args`: they name variables.
- A tool that ignores `executionContext.signal` keeps the remote call running after a cancel.
- Taking the tenant from an MCP or A2A request body: bind it from the authenticated caller (the
  resolver reads headers and the socket only).
- `new SupportA2aCallerResolver(…)` by hand: list it in `providers`; the listener takes the
  container's instance (its environment, hooks and test overrides).
