/**
 * #1319b (security): an MCP HTTP session binds to the WHOLE identity that opened it (peer, owner, the
 * tenant record, the context values) — a tenant with no ownerId included —, a caller that names no owner
 * and no tenant is bound to its connection, and each message runs with that message's own verified
 * identity, never the opener's.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Agent, createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ExecutionStatus } from "../../src/app/types.js";
import { HttpAuthResult } from "../../src/http/http-auth.js";
import { HttpAuthenticator } from "../../src/http/http-authenticator.js";
import { Clock, SystemClock } from "../../src/infrastructure/clock.js";
import { Logger, SilentLogger } from "../../src/infrastructure/logger.js";
import { McpEndpoint } from "../../src/mcp/mcp-endpoint.decorator.js";
import { mcpHttpListener } from "../../src/mcp/mcp-http-listener.js";
import { mcpServerOf } from "../../src/mcp/mcp-server-instance.js";
import { mcpServerOptionsOf } from "../../src/mcp/mcp-service-helpers.js";
import { ChatStart } from "../testing/fixtures/desk.workflow.js";

@McpEndpoint({ name: "identity-mcp", version: "1.0.0", tools: [ChatStart] })
class IdentityMcp {}

/** The options every `app.resume` got: what a message ran with. */
const resumed: { ownerId?: string; tenantId?: string }[] = [];

const app = {
  name: "identity-app",
  resume: (_request: unknown, options: { ownerId?: string; tenantId?: string }) => {
    resumed.push(options);
    return Promise.resolve({ status: ExecutionStatus.Finished, output: { ok: true } });
  },
};

@HttpAuthenticator()
class HeaderAuthenticator {
  authenticate(request: { http: { headers: Record<string, string | string[] | undefined> } }) {
    const { headers } = request.http;
    const one = (name: string): string | undefined => {
      const value = headers[name];
      return typeof value === "string" ? value : undefined;
    };
    if (one("x-auth") === undefined) return HttpAuthResult.unauthenticated("no");
    const tenantId = one("x-tenant");
    const plan = one("x-plan");
    return HttpAuthResult.authenticated({
      ownerId: one("x-owner"),
      ...(tenantId === undefined ? {} : { tenant: { tenantId, plan } }),
    } as never);
  }
}

const servers: Server[] = [];
afterEach(() => {
  resumed.length = 0;
  for (const server of servers.splice(0)) server.close();
});

async function listening(): Promise<string> {
  const served = Object.assign(app, {
    resolve: (token: unknown) =>
      token === Logger
        ? new SilentLogger()
        : token === Clock
          ? new SystemClock()
          : new HeaderAuthenticator(),
  });
  const server = createServer(
    mcpHttpListener(served as never, {
      endpoint: IdentityMcp,
      authenticator: HeaderAuthenticator,
      publicUrl: "https://b.example",
      base: "/mcp",
    }),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/mcp`;
}

const MCP = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const INIT = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "t", version: "1" },
  },
});
const RESUME = JSON.stringify({
  jsonrpc: "2.0",
  id: 2,
  method: "tools/call",
  params: { name: "resume_workflow", arguments: { pauseId: "p", decision: "{}" } },
});

const post = (url: string, headers: Record<string, string>, body: string) =>
  fetch(url, { method: "POST", headers: { ...MCP, ...headers }, body });

async function opened(url: string, headers: Record<string, string>): Promise<string> {
  const answer = await post(url, headers, INIT);
  await answer.text();
  expect(answer.status).toBe(200);
  return answer.headers.get("mcp-session-id") ?? "";
}

/** One POST over the connection `agent` keeps: what the server sees as one connection. */
function requestOn(
  url: string,
  agent: Agent,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; headers: IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { method: "POST", agent, headers: { ...MCP, "x-auth": "1", ...headers } },
      (res) => {
        let text = "";
        res.on("data", (chunk: Buffer) => (text += chunk.toString()));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text });
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

async function sessionOpenedOn(url: string, agent: Agent): Promise<string> {
  const answer = await requestOn(url, agent, {}, INIT);
  expect(answer.status).toBe(200);
  const id = answer.headers["mcp-session-id"];
  return typeof id === "string" ? id : "";
}

describe("#1319b: an MCP HTTP session binds to the whole identity", () => {
  it("the same tenantId with other context values is another caller: its message is refused", async () => {
    const url = await listening();
    const alice = { "x-auth": "1", "x-owner": "alice", "x-tenant": "t1", "x-plan": "free" };
    const id = await opened(url, alice);

    const upgraded = await post(
      url,
      { ...alice, "x-plan": "enterprise", "mcp-session-id": id },
      RESUME,
    );

    expect(upgraded.status).toBe(404);
    expect(resumed).toEqual([]);
  });

  it("a tenant with no ownerId is bound to the whole tenant identity, not refused", async () => {
    const url = await listening();
    const team = { "x-auth": "1", "x-tenant": "t1", "x-plan": "free" };
    const id = await opened(url, team);

    const same = await post(url, { ...team, "mcp-session-id": id }, RESUME);
    await same.text();
    const otherPlan = await post(url, { ...team, "x-plan": "pro", "mcp-session-id": id }, RESUME);
    const otherTenant = await post(
      url,
      { ...team, "x-tenant": "t2", "mcp-session-id": id },
      RESUME,
    );

    expect(same.status).toBe(200);
    expect(resumed).toMatchObject([{ tenantId: "t1" }]);
    expect(otherPlan.status).toBe(404);
    expect(otherTenant.status).toBe(404);
  });

  it("a caller that names no owner and no tenant is bound to its connection, never shared", async () => {
    const url = await listening();
    const one = new Agent({ keepAlive: true });
    const another = new Agent({ keepAlive: true });
    try {
      const id = await sessionOpenedOn(url, one);

      expect((await requestOn(url, one, { "mcp-session-id": id }, RESUME)).status).toBe(200);
      expect((await requestOn(url, another, { "mcp-session-id": id }, RESUME)).status).toBe(404);
      expect((await sessionOpenedOn(url, another)) === id).toBe(false);
    } finally {
      one.destroy();
      another.destroy();
    }
  });

  it("each message runs with its own verified caller: the owner and tenant of that message", async () => {
    const url = await listening();
    const alice = { "x-auth": "1", "x-owner": "alice", "x-tenant": "t1", "x-plan": "free" };
    const id = await opened(url, alice);

    const answer = await post(url, { ...alice, "mcp-session-id": id }, RESUME);
    await answer.text();

    expect(answer.status).toBe(200);
    expect(resumed).toEqual([expect.objectContaining({ ownerId: "alice", tenantId: "t1" })]);
  });
});

describe("#1319b: a server names the identity of each message from that message", () => {
  it("two calls of one connection run with the identities their own messages were verified as", async () => {
    const identities = [{ ownerId: "alice" }, { ownerId: "bob" }];
    let next = 0;
    const options = mcpServerOptionsOf(IdentityMcp);
    if (options === undefined) throw new Error("not an endpoint");
    const server = mcpServerOf(
      Object.assign(app, { hasTool: () => false }) as never,
      options,
      () => identities[next++] ?? {},
    );
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "t", version: "1" });
    await client.connect(clientSide);
    const call = () =>
      client.callTool({ name: "resume_workflow", arguments: { pauseId: "p", decision: "{}" } });

    await call();
    await call();

    expect(resumed.map((options) => options.ownerId)).toEqual(["alice", "bob"]);
  });
});
