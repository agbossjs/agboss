# MCP (Model Context Protocol)

`@agboss/core/mcp` works both ways:

- **Using MCP servers** — `@McpServer` declares a server and the server tools the workflow uses; a
  `@Tool` that calls it lists it in its `deps` (the server is connected at start). See
  [Components → MCP](Components#mcp) and [Tools](Tools).
- **Exposing tools over MCP** — `@McpEndpoint` lists the tools to offer to MCP clients (Claude Desktop,
  other agents) and is listed in `@Application({ endpoints })`; `mcpHttpListener` serves it over
  Streamable HTTP, `connectMcpStdio` over stdio, `connectMcp` over any transport. This page is about
  this side.

## 1. What to expose — `@McpEndpoint`

<!-- snippet-context
import { Tool, WorkflowStart } from "@agboss/core";
import { Text, WorkflowStartTextDto } from "@agboss/core/dto";
class IssueQuery { @Text() query!: string; }
class Issues { @Text() text!: string; }
@Tool({ name: "search-issues-tool", description: "Searches the tracker", input: IssueQuery, output: Issues })
class SearchIssues { execute(): Promise<Issues> { return Promise.resolve({ text: "" }); } }
-->

```ts
// src/mcp/job-scout.mcp-endpoint.ts
import { McpEndpoint } from "@agboss/core/mcp";

@McpEndpoint({
  name: "job-scout-mcp",
  version: "1.0.0",
  description: "Searches the tracker",
  tools: [SearchIssues], // tools of the application's workflows
})
export class JobScoutMcp {}
```

- A `@Tool` export runs through the same adapter as an agent's tool call: its input and output DTOs
  become the JSON Schemas, both are validated, its timeout applies, it gets a `callId`. It must be
  a tool of the application's workflows (one of its agents' tools), else the application is refused at
  assembly naming it.
- The endpoint is listed in `@Application({ endpoints: [JobScoutMcp] })`; an endpoint no application
  lists is `[application.endpoint-unlisted]` when its listener is made.

## 2. Serving it locally (stdio)

For Claude Desktop and other local clients, `connectMcpStdio` talks over stdin/stdout:

<!-- snippet-context
import { createApp } from "@agboss/core";
declare class JobScoutApplication {}
declare class JobScoutMcp {}
-->

```ts
import { connectMcpStdio } from "@agboss/core/mcp";

const app = await createApp(JobScoutApplication);
const connection = await connectMcpStdio(app, {
  endpoint: JobScoutMcp,
  session: { tenant: { tenantId: "acme" } }, // who every call of this local client runs as
});
// serves until stdin closes; `await connection.close()` ends it earlier
```

## 3. Serving it over HTTP

`mcpHttpListener(app, { endpoint, publicUrl, authenticator?, allowAnonymous?, base?, maxBodySize?,
onError? })` is a Node request handler, symmetric with `a2aHttpListener`. Every request is admitted on
its own before anything of it is read as MCP: a signed mesh peer (`X-AGBoss-Mesh`, verified against
this very request) or a caller the `@HttpAuthenticator` judges. A session belongs to the identity
that opened it (`Mcp-Session-Id`): another caller's request naming its id is answered "no such
session". The caller's tenant and owner come from the authenticator, never from a call's arguments;
components read them through their `ExecutionContext` — authorization stays out of the tools' code
([Context and Authorization](Context-And-Authorization)). Without an authenticator the listener is
refused unless `allowAnonymous: true` is set, and an application that serves several instances' MCP
sets `publicUrl` (required with an `@Mesh`).

<!-- snippet-context
import { type App } from "@agboss/core";
import { mcpHttpListener } from "@agboss/core/mcp";
declare const app: App;
declare class JobScoutMcp {}
-->

```ts
import { createServer } from "node:http";

const handle = mcpHttpListener(app, {
  endpoint: JobScoutMcp,
  publicUrl: "https://agents.example.com/mcp",
  allowAnonymous: true, // dev only: list an @HttpAuthenticator as `authenticator` in production
});

createServer(handle).listen(3001);
```

`connectMcp(app, { endpoint, transport, session })` takes any MCP wire transport instead (e.g. in
tests, an in-memory pair).

## 4. Calls between AGBoss applications — `_meta` (#398)

An AGBoss application's `@McpServer` calls made inside an execution send `_meta`:

- `callId` — the step's `executionContext.step.idempotencyKey` (over an MCP server, the execution id and
  this key follow the caller's stable identity — tenant, owner, peer, tool and `callId` — not the MCP session,
  so a retry after a reconnect, an idle timeout or a restart repeats the same call; an anonymous caller,
  with no tenant, owner or peer, is no one principal: its key is per session, a retry in a new session is a new call), so an AGBoss MCP server answers a
  repeated call as the same one (its call frame's key follows it);
- `"agboss.dev/mesh"` — the mesh envelope ([A2A → The mesh](A2A#6-the-mesh--call-chains-hops-and-loops-398)),
  the same unsecured JWS as the `agboss-mesh` header;
- `traceparent` — the W3C trace context.

Outside an execution nothing is sent. The endpoint reads `_meta["agboss.dev/mesh"]` as a claim
(a malformed one is ignored): a chain that already passed through this application's tool — an
exported tool, each an entry of the chain — or that is as long
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
owner, peer, callId)` (#398 PR 2b; an A2A v1.0 task by its `messageId`, #808): a repeat gets the kept result without
running again, one while the first still runs an error result with `_meta["agboss.dev/error"]`
`{ code: "mesh.request-in-progress" }`; a call that threw is forgotten. Untrusted calls are never
deduplicated.
