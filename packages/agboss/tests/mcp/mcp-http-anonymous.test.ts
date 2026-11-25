/**
 * #1319 / #1320: an MCP listener serves anonymous callers only when made with `allowAnonymous: true`
 * (no `tenantContext` of its own, no authenticator beside it); a forgotten authenticator is a
 * `ConfigError` at start. An anonymous caller is the session's own: `anonymous:<Mcp-Session-Id>`,
 * never its connection — the session answers whoever holds its id, over any connection, and two
 * clients behind one pooled connection hold two sessions.
 */
import { randomUUID } from "node:crypto";
import { Agent, createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError } from "../../src/core/error-families/config-errors.js";
import { Clock, SystemClock } from "../../src/infrastructure/clock.js";
import { Logger, SilentLogger } from "../../src/infrastructure/logger.js";
import { McpEndpoint } from "../../src/mcp/mcp-endpoint.decorator.js";
import { mcpHttpListener } from "../../src/mcp/mcp-http-listener.js";
import { rememberMeshSettings, type MeshSettings } from "../../src/mesh/mesh-settings.js";
import { MeshInboundMode } from "../../src/mesh/mesh.decorator.js";
import { MESH_DEFAULTS } from "../helpers/mesh-settings.js";

@McpEndpoint({ name: "open-mcp", version: "1.0.0", tools: [] })
class OpenMcp {}

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

function appOf(
  isBaseTenantContext: boolean,
  peers: MeshSettings["peers"] = new Map(),
  inboundMode: MeshInboundMode = MeshInboundMode.AllowExternal,
): object {
  const settings = {
    ...MESH_DEFAULTS,
    application: "open",
    keys: { peers: new Map() },
    endpoints: [OpenMcp],
    isBaseTenantContext,
    peers,
    inboundMode,
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
      allowAnonymous: true,
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

describe("an MCP listener that allows anonymous callers (no tenantContext)", () => {
  it("binds the session to its id: any connection holding it is served, a guessed id is not", async () => {
    const url = await listening();
    const mine = new Agent({ keepAlive: true });
    const theirs = new Agent({ keepAlive: true });
    try {
      const opened = await post(url, mine, {}, INIT);
      const id = String(opened.headers["mcp-session-id"]);

      expect(opened.status).toBe(200);
      expect((await post(url, mine, { "mcp-session-id": id }, PING)).status).toBe(200);
      // the POST and the GET of one client may ride different connections: the id is what binds
      expect((await post(url, theirs, { "mcp-session-id": id }, PING)).status).toBe(200);
      expect((await post(url, theirs, { "mcp-session-id": randomUUID() }, PING)).status).toBe(404);
    } finally {
      mine.destroy();
      theirs.destroy();
    }
  });

  it("two clients behind one pooled connection hold two sessions, each its own", async () => {
    const url = await listening();
    const pooled = new Agent({ keepAlive: true, maxSockets: 1 });
    try {
      const first = await post(url, pooled, {}, INIT);
      const second = await post(url, pooled, {}, INIT);
      const [a, b] = [first, second].map((each) => String(each.headers["mcp-session-id"]));

      expect(a).not.toBe(b);
      expect((await post(url, pooled, { "mcp-session-id": String(a) }, PING)).status).toBe(200);
      expect((await post(url, pooled, { "mcp-session-id": String(b) }, PING)).status).toBe(200);
      // the connection says nothing of who calls: a request naming no session is a new one
      expect((await post(url, pooled, {}, PING)).headers["mcp-session-id"]).not.toBe(a);
    } finally {
      pooled.destroy();
    }
  });

  it("needs no publicUrl without a @Mesh that has peers, and takes a function for it", () => {
    const app = appOf(true) as never;

    expect(() => mcpHttpListener(app, { endpoint: OpenMcp, allowAnonymous: true })).not.toThrow();
    expect(() =>
      mcpHttpListener(app, {
        endpoint: OpenMcp,
        allowAnonymous: true,
        publicUrl: () => "https://open.example",
      }),
    ).not.toThrow();
  });

  it("requires a publicUrl under a @Mesh with peers: signatures must name its origin", () => {
    const meshed = appOf(
      true,
      new Map([["a", { allowEndpoints: undefined, propagateTenant: false }]]),
    );

    expect(() =>
      mcpHttpListener(meshed as never, { endpoint: OpenMcp, allowAnonymous: true }),
    ).toThrow("[mcp.public-url-invalid]");
  });
});

describe("a forgotten authenticator is a ConfigError at start", () => {
  const code = "[http.authenticator-required-for-tenant-context]";
  const options = { endpoint: OpenMcp, publicUrl: "https://o.example" };

  it("no authenticator and no allowAnonymous: the listener is not made", () => {
    const made = () => mcpHttpListener(appOf(true) as never, options);

    expect(made).toThrow(ConfigError.Option);
    expect(made).toThrow(code);
  });

  it("with a tenantContext, allowAnonymous is refused, and so is no authenticator", () => {
    const anonymous = () =>
      mcpHttpListener(appOf(false) as never, { ...options, allowAnonymous: true });
    const forgotten = () => mcpHttpListener(appOf(false) as never, options);

    expect(anonymous).toThrow(ConfigError.Option);
    expect(anonymous).toThrow(code);
    expect(forgotten).toThrow(code);
  });

  it("only signed peers call a Strict mesh whose peer propagates its tenant: no authenticator needed", () => {
    const strict = appOf(
      false,
      new Map([["a", { allowEndpoints: undefined, propagateTenant: true }]]),
      MeshInboundMode.Strict,
    );

    expect(() =>
      mcpHttpListener(strict as never, { ...options, publicUrl: "https://o.example" }),
    ).not.toThrow();
  });
});
