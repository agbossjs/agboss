# MCP (Model Context Protocol)

`@agboss/core/mcp` works both ways:

- **Using MCP servers** — `@McpServer` declares a server and the server tools the workflow uses,
  `@McpTool` is a tool with that server injected. See [Components → MCP](Components#mcp) and
  [Tools](Tools).
- **Exposing a workflow over MCP** — `@McpExpose` lists the workflow's tools and workflow starts to
  offer to MCP clients (Claude Desktop, other agents); `createMcpService` serves them over stdio or
  HTTP. This page is about this side.

## 1. What to expose — `@McpExpose`

<!-- snippet-context
import { Tool, WorkflowStart, type ToolHandler } from "@agboss/core";
import { Text, WorkflowStartTextDto } from "@agboss/core/dto";
class IssueQuery { @Text() query!: string; }
class Issues { @Text() text!: string; }
@Tool({ name: "search-issues-tool", description: "Searches the tracker", input: IssueQuery, output: Issues })
class SearchIssues implements ToolHandler<IssueQuery, Issues> { run(): Promise<Issues> { return Promise.resolve({ text: "" }); } }
@WorkflowStart({ name: "chat-workflow-start", description: "A message", input: WorkflowStartTextDto })
class ChatWorkflowStart {}
-->

```ts
// src/mcp/job-scout.expose.ts
import { McpExpose } from "@agboss/core/mcp";

@McpExpose({
  name: "job-scout-mcp",
  version: "1.0.0",
  exports: [SearchIssues, ChatWorkflowStart], // tools of the workflow, and its workflow starts
})
export class JobScoutMcp {}
```

- A `@Tool` / `@McpTool` export runs through the same adapter as an agent's tool call: its input and
  output DTOs become the JSON Schemas, both are validated, its timeout applies, it gets a `callId`.
  It must be a tool of the workflow (one of its agents' tools), else `createMcpService` fails naming it.
- A `@WorkflowStart` export becomes a tool that runs the workflow (`app.execute`); with any start
  exported, `resume_workflow` (`app.resume`) is offered too.

## 2. Serving it locally (stdio)

For Claude Desktop and other local clients, the service talks over stdin/stdout:

<!-- snippet-context
import { createApp } from "@agboss/core";
declare class JobScoutApplication {}
declare class JobScoutMcp {}
-->

```ts
import { createMcpService } from "@agboss/core/mcp";

const app = await createApp(JobScoutApplication);
const service = createMcpService(app, JobScoutMcp);
await service.connectStdio(); // serves until stdin closes
```

## 3. Serving it over HTTP

`McpService` knows no HTTP framework: `handleSse(res, messageEndpoint, session)` opens a session's
event stream, `handleMessage(req, res, sessionId, body)` takes the client's messages. The `session`
(`McpSessionOptions`: `tenant`, `execution`, `ownerId` — the typed context values, #261) is what
every execution and resume of the session runs with, taken from the authenticated caller, never
from a call's arguments; components read it through their `ExecutionContext` — authorization stays
out of the tools' code ([Context and Authorization](Context-And-Authorization)).

<!-- snippet-context
import type { McpService } from "@agboss/core/mcp";
declare const service: McpService;
-->

```ts
import { createServer } from "node:http";

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "GET" && url.pathname === "/mcp") {
    const tenantId = req.headers["x-tenant-id"]?.toString() ?? "default"; // after authentication
    void service.handleSse(res, "/mcp/messages", { tenant: { tenantId } }); // bound to this session
    return;
  }
  if (req.method === "POST" && url.pathname === "/mcp/messages") {
    void service.handleMessage(req, res, url.searchParams.get("sessionId") ?? "");
    return;
  }
  res.writeHead(404).end();
}).listen(3001);
```

`service.connect(transport, session)` takes any MCP SDK transport instead (e.g. in tests, an
in-memory pair).

## 4. Calls between AGBoss applications — `_meta` (#398)

An AGBoss application's `@McpServer` calls made inside an execution send `_meta`:

- `callId` — the step's `executionContext.step.idempotencyKey`, so an AGBoss MCP server answers a
  repeated call as the same one (its call frame's key follows it);
- `"agboss.dev/mesh"` — the mesh envelope ([A2A → The mesh](A2A#6-the-mesh--call-chains-hops-and-loops-398)),
  the same unsecured JWS as the `agboss-mesh` header;
- `traceparent` — the W3C trace context.

Outside an execution nothing is sent. `createMcpService` reads `_meta["agboss.dev/mesh"]` as a claim
(a malformed one is ignored): a chain that already passed through this application's tool — an
exported start or an exported `@Tool` / `@McpTool`, each an entry of the chain — or that is as long
as its `@Application({ maxMeshHops })` is refused before it runs, with an error result whose
`_meta["agboss.dev/error"]` is `{ code: "limit.mesh-loop" | "limit.hops", error, details }`. An
admitted start runs with the chain (its own calls carry it on); an execution or a tool that fails
with one of these limits answers the same way. The AGBoss client throws such a result as
`MeshLoopDetectedError` / `HopsLimitExceededError` — the calling step fails with it, and
`McpServerClient.call` passes it on as it is.

**Trusted peers (#398 PR 2).** With `@Application({ mesh })` the envelope is signed
([A2A → Trusted peers](A2A#trusted-peers--signed-envelopes-398-pr-2)) and its `bodyHash` is the hash
of the call's `JSON.stringify(arguments)`. The session names its peer — what the transport
authenticated: `createMcpService(app, X).connect(transport, { peer: "orders-application" })` (and
the same option of the HTTP session). A call whose envelope carries that peer's valid signature,
unexpired, for these arguments is trusted: it runs on the caller's budget (`caller-budget`),
deadline and origin, and its result's `_meta["agboss.dev/report"]` is the signed run report the
AGBoss client verifies and records (`mcp:<issuer>` spend, `ToolCallRecord.remote`). A bad signature,
an expired envelope or other arguments are refused before anything runs — an error result with
`_meta["agboss.dev/error"]` `{ code: "mesh.signature-invalid" | "mesh.envelope-expired" |
"mesh.body-mismatch" }`. A trusted call with a `_meta.callId` (the AGBoss client sends the calling
step's idempotency key) is deduplicated in the application's `MeshRequestRepository` by `(tenant,
peer, callId)`, as `POST /execute` is over A2A (#398 PR 2b): a repeat gets the kept result without
running again, one while the first still runs an error result with `_meta["agboss.dev/error"]`
`{ code: "mesh.request-in-progress" }`; a call that threw is forgotten. Untrusted calls are never
deduplicated.
