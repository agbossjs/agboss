import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "../../src/application/create-app.js";
import type { App } from "../../src/app/types.js";
import { McpServerClient } from "../../src/components/mcp-client.js";
import { runInFrame } from "../../src/flow/context/frame.js";
import { HopsLimitExceededError, MeshLoopDetectedError } from "../../src/index.js";
import { createMcpService, McpExpose } from "../../src/mcp/index.js";
import { encodeMeshEnvelope } from "../../src/mesh/mesh-envelope-codec.js";
import type { MeshHop } from "../../src/mesh/mesh-hop.js";
import { connectMcpServers, mcpResultValue, mcpServer } from "../../src/tools/index.js";
import { callTool, replyWith } from "../../src/testing/index.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { testFrame } from "../helpers/frame.js";
import { offline } from "../a2a/fixtures/remote.workflow.js";
import { meshAppOf, PeerQuestion, PeerReply } from "../a2a/fixtures/mesh.workflow.js";

const apps: App[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  servers.splice(0).forEach((server) => {
    server.closeAllConnections();
    server.close();
  });
});

const claimed = (callChain: readonly MeshHop[]): string =>
  encodeMeshEnvelope({
    schema: 1,
    issuer: "elsewhere-application",
    origin: {
      rootExecutionId: "root-1",
      executionId: "root-1",
      workflow: { name: "elsewhere-workflow", version: "1.0.0" },
      step: { component: "ask-agent", idempotencyKey: "root-1:ask-agent:1:call_1" },
    },
    callChain,
  });

const elsewhere: MeshHop = {
  application: "elsewhere-application",
  start: "elsewhere-workflow-start",
  executionId: "root-1",
};

/** A peer that answers every A2A call and keeps each request's headers. */
async function peer(): Promise<{
  readonly url: string;
  readonly headers: IncomingMessage["headers"][];
}> {
  const headers: IncomingMessage["headers"][] = [];
  const server = createServer((req, res) => {
    headers.push(req.headers);
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "finished", output: { text: "peer says hi" } }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`, headers };
}

/** The orders application served over MCP (its start and its tool), and a client connected to it. */
async function served(book: ScriptBook, peerUrl: string, maxMeshHops?: number) {
  const parts = meshAppOf({
    name: "orders",
    peerUrl,
    ...(maxMeshHops === undefined ? {} : { maxMeshHops }),
  });
  @McpExpose({ name: "orders-mcp", version: "1.0.0", exports: [parts.MeshStart, parts.CallPeer] })
  class OrdersMcp {}
  const app = await createApp(parts.MeshApplication, offline(book));
  apps.push(app);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpService(app, OrdersMcp).connect(serverSide);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientSide);
  return { client, parts };
}

describe('#398 PR 1: an MCP server reads _meta["agboss.dev/mesh"]', () => {
  it("a loop back to an exported start is refused before it runs, the limit in _meta", async () => {
    const book = new ScriptBook();
    const { client } = await served(book, "http://unused");
    const own = {
      application: "orders-application",
      start: "orders-workflow-start",
      executionId: "o-1",
    };

    const result = await client.callTool({
      name: "orders-workflow-start",
      arguments: { text: "hi" },
      _meta: { "agboss.dev/mesh": claimed([own, elsewhere]) },
    });

    expect(result.isError).toBe(true);
    expect(result._meta?.["agboss.dev/error"]).toMatchObject({
      code: "limit.mesh-loop",
      details: { entry: { application: "orders-application", start: "orders-workflow-start" } },
    });
    expect(book.scriptOf("agent:orders-desk-agent").requests).toHaveLength(0);
  });

  it("an exported tool counts as an entry: a chain as long as maxMeshHops is refused", async () => {
    const { client } = await served(new ScriptBook(), "http://unused", 1);

    const result = await client.callTool({
      name: "orders-call-peer-tool",
      arguments: { question: "q" },
      _meta: { "agboss.dev/mesh": claimed([elsewhere]) },
    });

    expect(result._meta?.["agboss.dev/error"]).toMatchObject({
      code: "limit.hops",
      details: { maxMeshHops: 1, hops: 2 },
    });
  });

  it("an admitted start runs with the chain: its own calls carry it on, the trace continued", async () => {
    const book = new ScriptBook();
    const remote = await peer();
    const { client, parts } = await served(book, remote.url);
    book
      .scriptOf("agent:orders-desk-agent")
      .thenReturn(callTool(parts.CallPeer, { question: "q" }), replyWith("done"));
    const trace = "0af7651916cd43dd8448eb211c80319c";

    const result = await client.callTool({
      name: "orders-workflow-start",
      arguments: { text: "hi" },
      _meta: {
        "agboss.dev/mesh": claimed([elsewhere]),
        traceparent: `00-${trace}-b7ad6b7169203331-01`,
      },
    });

    const [sent] = remote.headers;
    const envelope: unknown = JSON.parse(
      Buffer.from(String(sent?.["agboss-mesh"]).split(".")[1] ?? "", "base64url").toString("utf8"),
    );
    expect(result.isError).toBeFalsy();
    expect(envelope).toMatchObject({
      callChain: [elsewhere, { application: "orders-application", start: "orders-workflow-start" }],
    });
    expect(sent?.traceparent).toMatch(new RegExp(`^00-${trace}-`));
  });

  it("a malformed envelope is ignored: the call runs", async () => {
    const book = new ScriptBook();
    const { client } = await served(book, "http://unused");
    book.scriptOf("agent:orders-desk-agent").thenReturn(replyWith("ok"));

    const result = await client.callTool({
      name: "orders-workflow-start",
      arguments: { text: "hi" },
      _meta: { "agboss.dev/mesh": "not.a-jws" },
    });

    expect(result.isError).toBeFalsy();
  });
});

describe("#398 PR 1: the AGBoss MCP client sends _meta and reads a mesh limit", () => {
  /** An MCP server that keeps every call's `_meta` and answers with `answer`. */
  async function recordingServer(answer: Record<string, unknown>) {
    const metas: unknown[] = [];
    const mcp = new McpServer({ name: "kb", version: "1.0.0" }, { capabilities: { tools: {} } });
    mcp.server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: [
        { name: "search", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
      ],
    }));
    mcp.server.setRequestHandler(CallToolRequestSchema, (request) => {
      metas.push(request.params._meta);
      return answer;
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverSide);
    const kb = mcpServer("kb");
    const search = kb.tool({
      tool: "search",
      description: "Search",
      input: z.object({ q: z.string() }),
      output: z.string(),
    });
    const connections = await connectMcpServers(
      { kb: { transport: "stdio", command: "unused" } },
      [kb],
      [search],
      {},
      () => clientSide,
    );
    return { metas, search, connections };
  }

  const ctx = { signal: new AbortController().signal, reportCost: () => undefined };

  it("inside an execution: _meta.callId is the step's key, with the envelope and traceparent", async () => {
    const { metas, search, connections } = await recordingServer({
      content: [{ type: "text", text: "hit" }],
    });
    const frame = testFrame();
    const mesh = { chain: [elsewhere] };

    await runInFrame({ ...frame, execution: { ...frame.execution, mesh } }, () =>
      search.invoke({ q: "x" }, ctx),
    );
    await search.invoke({ q: "y" }, ctx); // outside any execution
    await connections.close();

    expect(metas[0]).toMatchObject({
      callId: frame.step.idempotencyKey,
      "agboss.dev/mesh": expect.stringMatching(/^eyJ[\w-]+\.[\w-]+\.$/),
      traceparent: expect.stringMatching(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/),
    });
    expect(metas[1]).toBeUndefined();
  });

  it("an error result carrying a mesh limit throws it typed, whatever the server's text", () => {
    const details = {
      entry: { application: "kb-application", start: "search" },
      chain: [elsewhere],
    };
    const raw = {
      isError: true,
      content: [{ type: "text", text: "Error: looped" }],
      _meta: { "agboss.dev/error": { code: "limit.mesh-loop", error: "looped", details } },
    };

    expect(() => mcpResultValue(raw, z.string())).toThrow(MeshLoopDetectedError);
  });

  it("McpServerClient.call passes a mesh limit on as it is", async () => {
    const tools = { search: { input: PeerQuestion, output: PeerReply } };
    class KbServer extends McpServerClient<typeof tools> {}
    const server = new KbServer();
    const limit = new HopsLimitExceededError(
      { application: "kb-application", start: "search" },
      [elsewhere],
      1,
    );
    server.attachServerTools(
      new Map([
        [
          "search",
          {
            invoke: () => Promise.resolve({ kind: "error", message: limit.message, cause: limit }),
          },
        ],
      ]),
    );

    const call = server.call("search", { question: "q" });

    await expect(call).rejects.toBe(limit);
  });
});
