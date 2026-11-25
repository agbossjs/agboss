/**
 * An MCP HTTP listener bounds its sessions (#1319): an idle one is closed, one caller keeps at most
 * `maxSessionsPerCaller` (`429`, `mcp.too-many-sessions`), and the listener at most `maxSessions`
 * (`503`, `mcp.sessions-exhausted`); a refused request opens nothing.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ExecutionStatus } from "../../src/app/types.js";
import { HttpAuthResult } from "../../src/http/http-auth.js";
import { HttpAuthenticator } from "../../src/http/http-authenticator.js";
import { Clock, SystemClock } from "../../src/infrastructure/clock.js";
import { Logger, SilentLogger } from "../../src/infrastructure/logger.js";
import { McpEndpoint } from "../../src/mcp/mcp-endpoint.decorator.js";
import { mcpHttpListener, type McpHttpListenerOptions } from "../../src/mcp/mcp-http-listener.js";
import { ms } from "../../src/units/index.js";
import { ChatStart } from "../testing/fixtures/desk.workflow.js";

@McpEndpoint({ name: "limits-mcp", version: "1.0.0", tools: [ChatStart] })
class LimitsMcp {}

const app = {
  name: "limits-app",
  resume: () => Promise.resolve({ status: ExecutionStatus.Finished, output: { ok: true } }),
};

@HttpAuthenticator()
class HeaderAuthenticator {
  authenticate(request: { http: { headers: Record<string, string | string[] | undefined> } }) {
    const owner = request.http.headers["x-owner"];
    if (typeof owner !== "string") return HttpAuthResult.unauthenticated("no");
    return HttpAuthResult.authenticated({ ownerId: owner });
  }
}

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

async function listening(limits: Partial<McpHttpListenerOptions>): Promise<string> {
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
      endpoint: LimitsMcp,
      authenticator: HeaderAuthenticator,
      publicUrl: "https://b.example",
      base: "/mcp",
      ...limits,
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
const PING = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" });

const post = (url: string, headers: Record<string, string>, body: string) =>
  fetch(url, { method: "POST", headers: { ...MCP, ...headers }, body });

/** Opens a session as `owner`; the answer, its body read. */
async function open(url: string, owner: string) {
  const answer = await post(url, { "x-owner": owner }, INIT);
  const text = await answer.text();
  return { status: answer.status, id: answer.headers.get("mcp-session-id") ?? "", text };
}

const sleep = (time: number) => new Promise((resolve) => setTimeout(resolve, time));

describe("#1319: the sessions of an MCP HTTP listener are bounded", () => {
  it("a caller over its cap is refused 429 with a typed code, another caller is not", async () => {
    const url = await listening({ maxSessionsPerCaller: 2 });
    expect((await open(url, "alice")).status).toBe(200);
    expect((await open(url, "alice")).status).toBe(200);

    const refused = await open(url, "alice");

    expect(refused.status).toBe(429);
    expect(JSON.parse(refused.text)).toMatchObject({ code: "mcp.too-many-sessions" });
    expect(refused.id).toBe("");
    expect((await open(url, "bob")).status).toBe(200);
  });

  it("the listener over its total cap refuses 503 with a typed code", async () => {
    const url = await listening({ maxSessions: 2 });
    await open(url, "alice");
    await open(url, "bob");

    const refused = await open(url, "carol");

    expect(refused.status).toBe(503);
    expect(JSON.parse(refused.text)).toMatchObject({ code: "mcp.sessions-exhausted" });
  });

  it("an idle session is closed: its id is then unknown, and its place is free again", async () => {
    const url = await listening({ sessionIdleTimeout: ms(150), maxSessionsPerCaller: 1 });
    const first = await open(url, "alice");
    expect((await open(url, "alice")).status).toBe(429);
    expect((await post(url, { "x-owner": "alice", "mcp-session-id": first.id }, PING)).status).toBe(
      200,
    );

    await sleep(500);

    const late = await post(url, { "x-owner": "alice", "mcp-session-id": first.id }, PING);
    expect(late.status).toBe(404);
    await late.text();
    expect((await open(url, "alice")).status).toBe(200);
  });

  it("a limit that is not a positive whole number is refused when the listener is made", () => {
    const served = Object.assign(app, { resolve: () => new HeaderAuthenticator() });
    expect(() =>
      mcpHttpListener(served as never, {
        endpoint: LimitsMcp,
        authenticator: HeaderAuthenticator,
        allowAnonymous: false,
        maxSessions: 0,
      }),
    ).toThrow(/mcp\.session-limit-invalid/u);
  });
});
