# 04 — MCP and A2A

Read this when an agent uses tools of an MCP server, when a workflow is offered to MCP clients, or
when one application calls another over A2A (agent-to-agent) or is called that way. Tools in general:
`03-components-di-and-lifecycle.md`; approvals: `05-channels-and-human-in-the-loop.md`.

| You want to…                                          | Use                                                                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| give an agent tools of an MCP server                  | `@McpServer` (`extends McpServerClient`) in `@Workflow({ mcp })` + `@McpTool` classes in the agent's `tools` |
| let Claude Desktop / another agent call your workflow | `@McpExpose` + `createMcpService(app, Expose)` (`agboss/mcp`)                                                |
| call a workflow of another AGBoss application         | `@A2AAgent` (`extends A2AClient`) in `providers`, injected into a `@Tool` or `@Action` (`agboss/a2a`)        |
| serve your workflow to A2A callers                    | `a2aHttpListener(app, { start, callerResolver })` (an `@Injectable` resolver in `providers`)                 |

## Using an MCP server

```ts file=src/support/mcp/issues.dto.ts
// mcp/issues.dto.ts — the server tools' DTOs: input and output of each one you use
import { ListOf, Text } from "agboss/dto";

export class IssueSearchDto {
  @Text({ prompt: "words to search the issues for" })
  query!: string;
}

export class IssueHitDto {
  @Text({ prompt: "the issue's title" })
  title!: string;

  @Text({ prompt: "the issue's link" })
  url!: string;
}

export class IssueHitsDto {
  @ListOf(IssueHitDto, { prompt: "the matching issues" })
  issues!: IssueHitDto[];
}
```

```ts file=src/support/mcp/issues.server.ts
// mcp/issues.server.ts — the server and the tools of it this workflow uses (checked at start)
import { McpServer, McpServerClient } from "agboss/mcp";
import { IssueHitsDto, IssueSearchDto } from "./issues.dto.js";

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
import { ExecutionContext, type ToolHandler } from "agboss";
import { McpTool } from "agboss/mcp";
import { kilobytes, seconds } from "agboss/units";
import { IssueHitsDto, IssueSearchDto } from "./issues.dto.js";
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

```ts file=src/support/a2a/order-desk.dto.ts
import { Text } from "agboss/dto";

export class OrderQuestionDto {
  @Text({ prompt: "the question for the order desk" })
  question!: string;
}

export class OrderDeskReplyDto {
  @Text({ prompt: "the order desk's answer" })
  text!: string;
}
```

```ts file=src/support/a2a/order-desk.a2a.ts
// a2a/order-desk.a2a.ts — the remote workflow as a provider; per-call headers from the execution
import { ExecutionContext } from "agboss";
import { A2AAgent, A2AClient } from "agboss/a2a";

@A2AAgent({
  name: "order-desk-a2a-agent",
  url: "https://orders.example/a2a", // POST <url>/execute, <url>/resume
  deps: [ExecutionContext],
})
export class OrderDeskA2aClient extends A2AClient {
  constructor(private readonly executionContext: ExecutionContext) {
    super();
  }

  protected override getHeaders(): Promise<Record<string, string>> {
    return Promise.resolve({
      "idempotency-key": this.executionContext.step.idempotencyKey, // the same on a retried call
      "x-tenant-id": this.executionContext.tenant.tenantId, // the remote side authenticates it
    });
  }
}
```

```ts file=src/support/tools/ask-order-desk.tool.ts
// tools/ask-order-desk.tool.ts — an agent delegates to the remote workflow through a tool
import { ExecutionContext, SpendRecorder, Tool, type ToolHandler } from "agboss";
import { seconds, usd } from "agboss/units";
import { OrderDeskReplyDto, OrderQuestionDto } from "../a2a/order-desk.dto.js";
import { OrderDeskA2aClient } from "../a2a/order-desk.a2a.js";

@Tool({
  name: "ask-order-desk-tool",
  description: "Asks the order desk about an order",
  input: OrderQuestionDto,
  output: OrderDeskReplyDto,
  timeout: seconds(60),
  deps: [OrderDeskA2aClient, ExecutionContext, SpendRecorder],
})
export class AskOrderDeskTool implements ToolHandler<OrderQuestionDto, OrderDeskReplyDto> {
  constructor(
    private readonly orderDeskA2aClient: OrderDeskA2aClient,
    private readonly executionContext: ExecutionContext,
    private readonly spendRecorder: SpendRecorder,
  ) {}

  async run({ question }: OrderQuestionDto): Promise<OrderDeskReplyDto> {
    const reply: OrderDeskReplyDto = await this.orderDeskA2aClient.execute(
      { text: question }, // the remote start's input
      OrderDeskReplyDto, // the remote finish's output, validated
      { signal: this.executionContext.signal }, // `threadId` continues a remote conversation
    );
    this.spendRecorder.record({ service: "order-desk-a2a", cost: usd(0.002) }); // its price per call
    return reply;
  }
}
```

```ts file=src/support/agents/support.agent.ts
import { Agent } from "agboss";
import { SearchIssuesTool } from "../mcp/search-issues.mcp.js";
import { AskOrderDeskTool } from "../tools/ask-order-desk.tool.js";

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

```ts file=src/support/a2a/api-key-directory.service.ts
// a2a/api-key-directory.service.ts — the host's own service (a database, a KMS, …)
import { Injectable } from "agboss";

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
import { Injectable } from "agboss";
import { A2ACallerResolution, A2ARoute, type A2ACallerRequest, type A2ACallerResolver } from "agboss/a2a";
import type { SupportWorkflowStart } from "../support.workflow.js";
import { ApiKeyDirectory, type ApiKeyGrant } from "./api-key-directory.service.js";

@Injectable({ deps: [ApiKeyDirectory] }) // created by the container, never `new`
export class SupportA2aCallerResolver implements A2ACallerResolver<typeof SupportWorkflowStart> {
  constructor(private readonly apiKeyDirectory: ApiKeyDirectory) {}

  async resolveCaller(request: A2ACallerRequest): Promise<A2ACallerResolution<typeof SupportWorkflowStart>> {
    const header: string = request.http.headers.authorization ?? ""; // headers and socket, never the body
    if (!header.startsWith("Bearer ")) {
      return A2ACallerResolution.unauthenticated({ reason: "no API key", challenge: 'Bearer realm="a2a"' });
    }
    const grant: ApiKeyGrant | undefined = await this.apiKeyDirectory.grantOf(header.slice("Bearer ".length));
    if (grant === undefined) return A2ACallerResolution.unauthenticated({ reason: "unknown API key" });
    if (request.route === A2ARoute.Resume && !grant.canAnswerPauses) {
      return A2ACallerResolution.forbidden({ reason: "this key may not answer pauses" });
    }
    return A2ACallerResolution.resolved({ tenant: { tenantId: grant.tenantId }, ownerId: grant.clientId });
  }
}
```

```ts file=src/support/support.workflow.ts
import { Application, Budget, BudgetPeriod, BudgetScope, EmptyEnvironment, Workflow, WorkflowFinish, WorkflowStart, start, type BudgetHandler } from "agboss";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "agboss/dto";
import { usd, type Usd } from "agboss/units";
import { ApiKeyDirectory } from "./a2a/api-key-directory.service.js";
import { OrderDeskA2aClient } from "./a2a/order-desk.a2a.js";
import { SupportA2aCallerResolver } from "./a2a/support.a2a-caller-resolver.js";
import { SupportAgent } from "./agents/support.agent.js";
import { IssuesServer } from "./mcp/issues.server.js";

@WorkflowStart({ name: "support-workflow-start", description: "A question", input: WorkflowStartTextDto })
export class SupportWorkflowStart {}

@WorkflowFinish({ name: "support-workflow-finish", description: "The answer", output: WorkflowFinishTextDto })
export class SupportWorkflowFinish {}

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
  providers: [OrderDeskA2aClient, ApiKeyDirectory, SupportA2aCallerResolver],
})
export class SupportWorkflow {}

@Budget({ name: "application-daily-budget", scope: BudgetScope.Application, period: BudgetPeriod.Day })
export class ApplicationDailyBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(5);
  }
}

@Budget({ name: "tenant-daily-budget", scope: BudgetScope.Tenant, period: BudgetPeriod.Day })
export class TenantDailyBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(1);
  }
}

@Budget({ name: "execution-budget", scope: BudgetScope.Execution })
export class ExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(0.1);
  }
}

@Application({
  name: "support-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [SupportWorkflow],
  budgets: [ApplicationDailyBudget, TenantDailyBudget, ExecutionBudget],
})
export class SupportApplication {}
```

- `execute(input, OutputDto, call)` returns the remote output validated by the DTO; any status but
  `A2AStatus.Finished` throws `A2ARemoteError` (`response.status`: `Paused` with `pauseIds`,
  `Failed`, `Limited`, `Cancelled`). `send(input, call)` returns the `A2AExecutionResponse` whatever
  the status — use it when the caller handles a remote pause itself.
- `call.onEvent` streams the remote run's progress (`{ type: "progress", payload: { step, content } }`).
- The remote side has no model cost you can see: record its price with `SpendRecorder` so the budgets
  count it. Pass `executionContext.signal` so a cancel or a timeout aborts the HTTP call.

## Exposing a workflow

Over MCP — the workflow's tools and starts become MCP tools; a start runs `app.execute`, and with any
start exported `resume_workflow` (`app.resume`) is offered too:

<!-- snippet-context
import { SearchIssuesTool } from "./src/support/mcp/search-issues.mcp.js";
import { SupportWorkflowStart } from "./src/support/support.workflow.js";
-->

```ts
// mcp/support.expose.ts
import { McpExpose } from "agboss/mcp";

@McpExpose({
  name: "support-mcp",
  version: "1.0.0",
  exports: [SearchIssuesTool, SupportWorkflowStart], // tools of the workflow, and its starts
})
export class SupportMcp {}
```

<!-- snippet-context
import { createApp } from "agboss";
import { McpExpose } from "agboss/mcp";
import { SupportApplication, SupportWorkflowStart } from "./src/support/support.workflow.js";
@McpExpose({ name: "support-mcp", version: "1.0.0", exports: [SupportWorkflowStart] })
export class SupportMcp {}
-->

```ts
// server.ts — local clients over stdio; for HTTP: service.handleSse(res, "/mcp/messages", session)
// and service.handleMessage(req, res, sessionId) in your HTTP framework
import { createMcpService } from "agboss/mcp";

const app = await createApp(SupportApplication);
const service = createMcpService(app, SupportMcp);
await service.connectStdio(); // serves until stdin closes
```

Over A2A — `POST <base>/execute` `{ input, threadId? }` and `POST <base>/resume` `{ pauseId, decision }`,
JSON or server-sent events (`Accept: text/event-stream`). The listener is built from the application:
its resolver comes from the container (listed in the application's or a workflow's `providers`, else
`a2aHttpListener` throws `[a2a.caller-resolver-not-listed]`), and every request's caller is resolved
before its body is read or a header written. A run that waits for an approval answers
`status: A2AStatus.Paused` (`"paused"` on the wire) with its `pauseIds`; the caller resumes it with a decision:

<!-- snippet-context
import { createApp } from "agboss";
import { SupportApplication, SupportWorkflowStart } from "./src/support/support.workflow.js";
import { SupportA2aCallerResolver } from "./src/support/a2a/support.a2a-caller-resolver.js";
-->

```ts
import { createServer } from "node:http";
import { a2aHttpListener } from "agboss/a2a";

const app = await createApp(SupportApplication, { env: "prod" });
createServer(
  a2aHttpListener(app, {
    start: SupportWorkflowStart,
    callerResolver: SupportA2aCallerResolver, // the class: its instance is the container's
    base: "/a2a",
  }),
).listen(8080);
```

| The resolver returns                                           | The caller gets                                                                                     |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `A2ACallerResolution.resolved({ tenant, ownerId, execution })` | the run, for that tenant and owner (a thread id is the tenant's own)                                |
| `.unauthenticated({ reason, challenge? })`                     | `401`, `WWW-Authenticate: <challenge>`, `{ "code": "a2a.caller-unauthenticated", "error": reason }` |
| `.forbidden({ reason })`                                       | `403`, `{ "code": "a2a.caller-forbidden", "error": reason }`                                        |
| it throws                                                      | `500`, `{ "code": "a2a.caller-resolution-failed" }` — never the error's text                        |

- A refused request runs nothing: no `onExecutionStart`, no `onExecutionRejected`, no record — and a
  streaming caller gets the real status, not an event stream. `A2AClient.send` throws
  `A2ACallerRejectedError` (`httpStatus`, `code`) on a `401` / `403`.
- `resolved({ … })` is typed by the start's application: with a declared `TenantContext` its values
  are required. A single-tenant host returns `A2ACallerResolution.resolved({})` — never implied.
- An answer is built only by `A2ACallerResolution` (branded: a plain object does not compile).
- Your own handler instead of the listener: `new A2AAdapter(app).execute(Start, { input, threadId },
onEvent, { tenant, execution, ownerId })` — the same values, from your authenticated caller;
  `adapter.cancel(threadId, caller)` cancels only that caller's tenant's thread.
- A caller that disconnects cancels its run (the listener aborts its `signal`).
- The names: `A2AApp` (what the listener takes of `App`), `A2AHttpListenerOptions`, `A2ACaller`,
  `A2ACallerRequest`, `A2ARoute`, `A2ACallerResolutionKind`, `ResolvedA2ACallerResolution`,
  `RejectedA2ACallerResolution`, `A2ACallerUnauthenticatedOptions`, `A2ACallerForbiddenOptions`.

Tests: the `a2aServer({ start, callerResolver })` fixture of `testWith` (an `A2AServerFixture`)
serves the test's `app` on `127.0.0.1:0` and returns an `A2ATestServer` — `{ url }` for `new
A2AClient({ url, headers })`; the loopback is open for it (no `allowNetwork`), it closes at the
test's end, and `override(ApiKeyDirectory, …)` replaces the resolver's services like any other
(reference 10):

```ts file=tests/support/support-a2a.test.ts
import { expect } from "vitest";
import { Injectable } from "agboss";
import { A2ACallerRejectedError, A2AClient } from "agboss/a2a";
import { override, testWith } from "agboss/testing";
import { ApiKeyDirectory, type ApiKeyGrant } from "../../src/support/a2a/api-key-directory.service.js";
import { SupportA2aCallerResolver } from "../../src/support/a2a/support.a2a-caller-resolver.js";
import { SupportAgent } from "../../src/support/agents/support.agent.js";
import { SupportApplication, SupportWorkflowStart } from "../../src/support/support.workflow.js";

@Injectable()
class NoKeysDirectory extends ApiKeyDirectory {
  override grantOf(): Promise<ApiKeyGrant | undefined> {
    return Promise.resolve(undefined); // every key unknown
  }
}

const test = testWith(SupportApplication, { overrides: [override(ApiKeyDirectory, NoKeysDirectory)] });

test("an unknown key is 401 and never runs", async ({ a2aServer, mockLlm }) => {
  const { url } = await a2aServer({ start: SupportWorkflowStart, callerResolver: SupportA2aCallerResolver });

  const sent = new A2AClient({ url, headers: { authorization: "Bearer key-x" } }).send({ text: "hi" });

  await expect(sent).rejects.toFailWith(A2ACallerRejectedError, { httpStatus: 401, code: "a2a.caller-unauthenticated" });
  expect(mockLlm(SupportAgent)).toHaveBeenCalledTimes(0);
});
```

## The mesh: call chains, hops and loops (#398)

AGBoss applications calling each other — over A2A (`A2AClient` → `a2aHttpListener`) or MCP (an
`@McpServer` → `createMcpService`) — are a mesh. Every call made **inside an execution** carries,
without any code of yours:

- the **envelope** (`MeshEnvelope`: `schema`, `issuer`, `origin` — `MeshOrigin` with its
  `MeshOriginStep` —, `callChain` of `MeshHop`s, each a `MeshEntry` plus its root `executionId`): the
  `agboss-mesh` request header over A2A, `_meta["agboss.dev/mesh"]` over MCP (a JWS — unsecured,
  `alg: "none"`, or signed, below); ids only — no `ownerId`, no `tenantId`, no input values;
- a W3C `traceparent` (header / `_meta.traceparent`): the caller's trace continued;
- over MCP `_meta.callId` = `executionContext.step.idempotencyKey`, so an AGBoss MCP server answers
  a repeated call as the same one.

Outside an execution (a script's `new A2AClient(…)`) nothing is sent. The receiver reads the
envelope into `A2ACallerRequest.envelope` for your resolver — a **claim** (unless signed by a
trusted peer, below): never take a tenant from it. A malformed envelope is ignored (the request runs as one
without). What it does apply is the chain, before anything runs:

| The chain the request arrives with                            | The receiver answers                                                         |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| already passed through its own application and start (a loop) | `409 { "code": "limit.mesh-loop", "error", "details": { entry, chain } }`    |
| as long as its `@Application({ maxMeshHops })` (default 8)    | `409 { "code": "limit.hops", "error", "details": { maxMeshHops, hops, … } }` |
| anything else                                                 | the run, whose own calls carry the chain on with its hop added               |

On the caller `A2AClient` rethrows them typed — `MeshLoopDetectedError` / `HopsLimitExceededError`,
both `LimitExceededError`s — and so does a remote run another hop's limit stopped (its response's
`code` / `details`), and an MCP error result with `_meta["agboss.dev/error"]`. A tool that meets one
**fails its step** (the model never reads it: retrying a loop loops again); take it on the path:

<!-- snippet-context
import { Agent, MeshLoopDetectedError, Workflow, WorkflowFinish, WorkflowStart, start, toFinish } from "agboss";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "agboss/dto";
@Agent({ name: "orders-agent", description: "Orders", prompt: "Answer.", model: "moonshotai/kimi-k2.6" })
export class OrdersAgent {}
@WorkflowStart({ name: "orders-workflow-start", description: "A question", input: WorkflowStartTextDto })
export class OrdersWorkflowStart {}
@WorkflowFinish({ name: "orders-workflow-finish", description: "The answer", output: WorkflowFinishTextDto })
export class OrdersWorkflowFinish {}
@WorkflowFinish({ name: "looped-workflow-finish", description: "Handed back", output: WorkflowStartTextDto })
export class LoopedWorkflowFinish {}
-->

```ts
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

- A loop is the same `(application, start)` twice in one chain — always, whatever the depth; another
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
import { Application, type Secret } from "agboss";
export class BillingWorkflow {} // a @Workflow of its own
-->

```ts
// environments/billing.environment.ts — the contract
export class BillingEnvironment {
  meshSigningKey!: Secret; // secret("MESH_SIGNING_KEY") in each environment
  ordersPublicKey!: string; // env("ORDERS_PUBLIC_KEY")
}

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

A request is **trusted** only when both hold: the listener's `callerResolver` names its `peer`
(`A2ACallerResolution.resolved({ …, peer: "orders-application" })` — what your transport proved,
mTLS or a token) and the envelope carries that peer's valid signature (`signedBy`). Before the
resolver the listener checks a signed envelope of a known issuer — its signature and its
`issuedAt` + `expiresIn` (60 s) on the `Clock` — and refuses a bad one with `401`
`mesh.signature-invalid` / `mesh.envelope-expired`; a trusted one must carry the body it signed
(`bodyHash`, else `401 mesh.body-mismatch`). `a2aHttpListener(app, { …, meshVerifier })` takes the
peers' public keys from an `@Injectable` `MeshVerifier` (`verifyKeyOf(issuer)` → PEM) besides
`mesh.peers`, asked first. Over MCP, `createMcpService(app, X).connect(transport, { peer })` names
the session's peer.

What a trusted request gets — never an untrusted one:

| From the caller                   | The receiver                                                                                                    |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `budget.remaining`                | one more execution budget, `caller-budget`: it only lowers its own (`BudgetExceededError`)                      |
| `deadline.remaining`              | the execution's deadline (`DeadlineExceededError`, `limit.deadline`)                                            |
| `origin` (and the chain's length) | `executionContext.origin`, the record's `origin` and every observer event's (`ExecutionOrigin`)                 |
| `origin.step.idempotencyKey`      | dedupe (`MeshRequestRepository`): a repeat gets the kept answer, one in flight a `409 mesh.request-in-progress` |

Its answer carries a run report (`MeshRunReport`: `issuer`, `executionId`, `spend`, `bodyHash`)
signed by the receiver. A caller that verifies it with its `mesh.peers` key records the reported
spend as `a2a:<issuer>` / `mcp:<issuer>` in the calling tool's spend and the remote execution in
`ToolCallRecord.remote` (`ToolCallRemote`: `application`, `executionId`); an unverified report is
ignored. The deadline is yours too: `app.execute(Start, input, { deadline: seconds(30) })` — the
smaller of it and a trusted caller's, checked before every step and model call (a call in flight is
not cut). `A2AClient.cancel(threadId)` → `POST <base>/cancel { threadId }`, for the resolved
caller's tenant only.

- `MeshRequestRepository` is infrastructure (in memory; `SqliteMeshRequestRepository` shares it
  between instances), kept `mesh.idempotencyRetention` (default `minutes(30)`), then removed by the
  recovery sweep. Only trusted `POST /execute` requests are deduplicated.
- `[mesh.signing-key-missing]`, `[mesh.unknown-peer-key]`, `[mesh.duplicate-peer]` at assembly;
  `[mesh.invalid-key] <field> holds no …` at start (never the value).
- Not yet (#398 PR 3): a peer's contract price, `audience`.

## Errors and fixes

| You see                                                        | Fix                                                                                    |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| the start fails: `search_issues: tool not found on the server` | the `tools` key must be the server's exact tool name                                   |
| the start fails: `… input: …` schema differences               | make the input DTO match the server tool's input schema                                |
| `MCP server "issues" needs env variable ISSUES_MCP_TOKEN`      | set the variable; the decorator only names it                                          |
| `[name.kind-suffix]` on an `@McpTool`                          | name it `<what>-tool`                                                                  |
| `[tool.duplicate-name]`                                        | two tools a model sees share a name (local, MCP, `search-<rag>-tool`, `answer-<dto>`)  |
| `A2ARemoteError: … "paused"`                                   | the remote run waits for an approval: use `send` and resume it, or approve remotely    |
| `[a2a.no-url]`                                                 | the client class lacks `@A2AAgent({ url })`                                            |
| `[a2a.caller-resolver-not-listed] … is not listed`             | list the resolver in `@Application({ providers })` or a `@Workflow({ providers })`     |
| `A2ACallerRejectedError … (401 a2a.caller-unauthenticated)`    | the server's resolver refused the client's credentials: check its `headers`            |
| `MeshLoopDetectedError` (`limit.mesh-loop`)                    | two applications call each other back: break the cycle, or `.onError` it to a finish   |
| `HopsLimitExceededError` (`limit.hops`)                        | the call chain is longer than the receiver's `maxMeshHops`: shorten it or raise it     |
| `401 mesh.signature-invalid` / `mesh.envelope-expired`         | the caller signs with another key than its peer entry, or the clocks differ by > 30 s  |
| `DeadlineExceededError` (`limit.deadline`)                     | the execution (or its trusted caller) ran out of time: raise `deadline`, or `.onError` |

## Pitfalls

- An MCP connection opened by hand in a service's `onStart`: declare the `@McpServer` instead, so the
  start checks its tools and tests stub it.
- Secrets in `@McpServer({ headers })` values or `args`: they name variables.
- A tool that ignores `executionContext.signal` keeps the remote call running after a cancel.
- Taking the tenant from an MCP or A2A request body: bind it from the authenticated caller (the
  resolver reads headers and the socket only).
- `new SupportA2aCallerResolver(…)` by hand: list it in `providers`; the listener takes the
  container's instance (its environment, hooks and test overrides).
