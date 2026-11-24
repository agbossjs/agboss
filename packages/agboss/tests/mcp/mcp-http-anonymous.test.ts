/**
 * #1319 / #1320: an application with no `tenantContext` of its own needs no `@HttpAuthenticator` on
 * its MCP listener: a caller is anonymous and its session is bound to its connection — another
 * connection naming the session id is answered "no such session". With a `tenantContext` and none,
 * the listener is not made (`ConfigError`).
 */
import { Agent, createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError } from "../../src/core/error-families/config-errors.js";
import { Clock, SystemClock } from "../../src/infrastructure/clock.js";
import { Logger, SilentLogger } from "../../src/infrastructure/logger.js";
import { McpEndpoint } from "../../src/mcp/mcp-endpoint.decorator.js";
import { mcpHttpListener } from "../../src/mcp/mcp-http-listener.js";
import { rememberMeshSettings, type MeshSettings } from "../../src/mesh/mesh-settings.js";
import { MESH_DEFAULTS } from "../helpers/mesh-settings.js";

@McpEndpoint({ name: "open-mcp", version: "1.0.0", tools: [] })
class OpenMcp {}

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

function appOf(isBaseTenantContext: boolean, peers: MeshSettings["peers"] = new Map()): object {
  const settings = {
    ...MESH_DEFAULTS,
    application: "open",
    keys: { peers: new Map() },
    endpoints: [OpenMcp],
    isBaseTenantContext,
    peers,
  } as never;
  const app = {
    resolve: (token: unknown) =>
      token === Logger ? new SilentLogger() : token === Clock ? new SystemClock() : undefined,
  };
  rememberMeshSettings(app, () => settings);
  return app;
}

async function listening(): Promise<string> {
  const server = createServer(
    mcpHttpListener(appOf(true) as never, {
      endpoint: OpenMcp,
      publicUrl: "https://open.example",
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
const PING = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" });

/** One POST over the connection `agent` keeps. */
function post(
  url: string,
  agent: Agent,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: "POST", agent, headers: { ...MCP, ...headers } }, (res) => {
      res.resume();
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers });
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

describe("an MCP listener with no authenticator (no tenantContext)", () => {
  it("serves an anonymous caller; its session answers only on its own connection", async () => {
    const url = await listening();
    const mine = new Agent({ keepAlive: true });
    const theirs = new Agent({ keepAlive: true });
    try {
      const opened = await post(url, mine, {}, INIT);
      const id = String(opened.headers["mcp-session-id"]);

      expect(opened.status).toBe(200);
      expect((await post(url, mine, { "mcp-session-id": id }, PING)).status).toBe(200);
      expect((await post(url, theirs, { "mcp-session-id": id }, PING)).status).toBe(404);
    } finally {
      mine.destroy();
      theirs.destroy();
    }
  });

  it("needs no publicUrl without a @Mesh that has peers, and takes a function for it", () => {
    const app = appOf(true) as never;

    expect(() => mcpHttpListener(app, { endpoint: OpenMcp })).not.toThrow();
    expect(() =>
      mcpHttpListener(app, { endpoint: OpenMcp, publicUrl: () => "https://open.example" }),
    ).not.toThrow();
  });

  it("requires a publicUrl under a @Mesh with peers: signatures must name its origin", () => {
    const meshed = appOf(true, new Map([["a", { allowEndpoints: undefined, propagateTenant: false }]]));

    expect(() => mcpHttpListener(meshed as never, { endpoint: OpenMcp })).toThrow(
      "[mcp.public-url-invalid]",
    );
  });

  it("is not made for an application with a tenantContext: a ConfigError", () => {
    const made = () =>
      mcpHttpListener(appOf(false) as never, { endpoint: OpenMcp, publicUrl: "https://o.example" });

    expect(made).toThrow(ConfigError.Option);
    expect(made).toThrow("[http.authenticator-required-for-tenant-context]");
  });
});
