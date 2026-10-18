# MCP (Model Context Protocol)

`agboss/mcp` works both ways:

- **Using MCP servers** — `@McpServer` declares a server and the server tools the workflow uses,
  `@McpTool` is a tool with that server injected. See [Components → MCP](Components#mcp) and
  [Tools](Tools).
- **Exposing a workflow over MCP** — `@McpExpose` lists the workflow's tools and workflow starts to
  offer to MCP clients (Claude Desktop, other agents); `createMcpService` serves them over stdio or
  HTTP. This page is about this side.

## 1. What to expose — `@McpExpose`

<!-- snippet-context
import { Tool, WorkflowStart, type ToolHandler } from "agboss";
import { Text, WorkflowStartTextDto } from "agboss/dto";
class IssueQuery { @Text() query!: string; }
class Issues { @Text() text!: string; }
@Tool({ name: "search_issues", description: "Searches the tracker", input: IssueQuery, output: Issues })
class SearchIssues implements ToolHandler<IssueQuery, Issues> { run(): Promise<Issues> { return Promise.resolve({ text: "" }); } }
@WorkflowStart({ name: "chat-workflow-start", description: "A message", input: WorkflowStartTextDto })
class ChatWorkflowStart {}
-->

```ts
// src/mcp/job-scout.expose.ts
import { McpExpose } from "agboss/mcp";

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
import { createApp } from "agboss";
declare class JobScoutApplication {}
declare class JobScoutMcp {}
-->

```ts
import { createMcpService } from "agboss/mcp";

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
import type { McpService } from "agboss/mcp";
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
