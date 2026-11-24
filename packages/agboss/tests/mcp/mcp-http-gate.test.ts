/**
 * #1320 (security): the mesh's gate of every HTTP request to an MCP endpoint — what `McpService`'s
 * `handleSse` / `handleMessage` pass before anything of the request is read as MCP: an unsigned request
 * to a Strict endpoint, an endpoint outside the peer's `allowEndpoints`, a replayed signature and a
 * request made for another body are refused with a code and a fixed text, a verified peer owns its calls.
 */
import { generateKeyPairSync } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { admitMcpHttp } from "../../src/mcp/mcp-http-gate.js";
import { McpEndpoint } from "../../src/mcp/mcp-endpoint.decorator.js";
import { mcpHttpListener } from "../../src/mcp/mcp-http-listener.js";
import { servedEndpointOf } from "../../src/mcp/mcp-server-instance.js";
import { Clock, SystemClock } from "../../src/infrastructure/clock.js";
import { Logger, SilentLogger } from "../../src/infrastructure/logger.js";
import { HttpAuthenticator } from "../../src/http/http-authenticator.js";
import { HttpAuthResult } from "../../src/http/http-auth.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { InMemoryMeshRequestRepository } from "../../src/infrastructure/mesh-request.repository.js";
import { signMeshHttp } from "../../src/mesh/mesh-http.js";
import { rememberMeshSettings, type MeshSettings } from "../../src/mesh/mesh-settings.js";
import { MeshInboundMode } from "../../src/mesh/mesh.decorator.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { MESH_DEFAULTS } from "../helpers/mesh-settings.js";

const NOW = new Date("2030-01-01T00:00:00.000Z");
const caller = generateKeyPairSync("ed25519");
const other = generateKeyPairSync("ed25519");
const ORIGIN = "https://b.example";
const OPEN_URL = `${ORIGIN}/mcp/sse`;

@McpEndpoint({ name: "orders-mcp-expose", version: "1.0.0", tools: [] })
class OrdersMcp {}
@McpEndpoint({ name: "admin-mcp-expose", version: "1.0.0", tools: [] })
class AdminMcp {}

function appOf(
  options: { mode?: MeshInboundMode; allow?: readonly (typeof OrdersMcp)[]; down?: boolean } = {},
): object {
  const store = new InMemoryMeshRequestRepository(new InMemoryDatabase());
  const settings = {
    ...MESH_DEFAULTS,
    application: "b",
    keys: {
      peers: new Map([
        ["a", [caller.publicKey]],
        ["c", [other.publicKey]],
      ]),
    },
    clock: new VirtualClock(NOW),
    inboundMode: options.mode ?? MeshInboundMode.Strict,
    peers: new Map([
      ["a", { allowEndpoints: options.allow, propagateTenant: false }],
      ["c", { allowEndpoints: options.allow, propagateTenant: false }],
    ]),
    requests:
      options.down === true
        ? () => ({ saveIfAbsent: () => Promise.reject(new Error("down")) })
        : () => store,
    endpoints: [OrdersMcp, AdminMcp],
  } as never;
  const app = {};
  rememberMeshSettings(app, () => settings);
  return app;
}

const header = (
  body: string,
  url = `${ORIGIN}/mcp/messages?sessionId=1`,
  as: { application: string; key: typeof caller.privateKey } = {
    application: "a",
    key: caller.privateKey,
  },
  method = "POST",
): string =>
  signMeshHttp(
    {
      application: as.application,
      keys: { signingKey: as.key, peers: new Map() },
      clock: new VirtualClock(NOW),
      envelopeTtl: 60_000,
    },
    { audience: "b", method, url, body },
  ) ?? "";

/** One request and what the gate answered. */
async function sent(
  app: object,
  endpoint: typeof OrdersMcp,
  options: { header?: string; body?: string; origin?: string } = {},
) {
  const body = options.body ?? '{"jsonrpc":"2.0"}';
  const req = {
    method: "POST",
    url: "/mcp/messages?sessionId=1",
    headers: options.header === undefined ? {} : { "x-agboss-mesh": options.header },
  } as never;
  const written: { status?: number; body?: string } = {};
  const res = {
    writeHead(status: number) {
      written.status = status;
      return this;
    },
    end(text: string) {
      written.body = text;
    },
  } as never;
  const admitted = await admitMcpHttp(app, endpoint, { req, res, body }, {}, options.origin);
  return { admitted, status: written.status, answer: written.body };
}

describe("#1320: the mesh's gate of an MCP HTTP request", () => {
  it("an unsigned request to a Strict endpoint is refused 401 with its code, nothing admitted", async () => {
    const answer = await sent(appOf(), OrdersMcp);

    expect(answer.admitted).toBeUndefined();
    expect(answer.status).toBe(401);
    expect(JSON.parse(answer.answer ?? "{}")).toMatchObject({ code: "mesh.signature-missing" });
  });

  it("an endpoint outside the peer's allowEndpoints is refused 403", async () => {
    const app = appOf({ allow: [OrdersMcp] });

    const answer = await sent(app, AdminMcp, { header: header('{"jsonrpc":"2.0"}') });

    expect(answer.admitted).toBeUndefined();
    expect(answer.status).toBe(403);
    expect(JSON.parse(answer.answer ?? "{}")).toMatchObject({ code: "mesh.endpoint-forbidden" });
  });

  it("a replayed signed request is refused: the second one", async () => {
    const app = appOf();
    const signed = header('{"jsonrpc":"2.0"}');

    const first = await sent(app, OrdersMcp, { header: signed });
    const second = await sent(app, OrdersMcp, { header: signed });

    expect(first.admitted?.session).toMatchObject({ peer: "a", ownerId: "mesh:a" });
    expect(second.admitted).toBeUndefined();
    expect(JSON.parse(second.answer ?? "{}")).toMatchObject({ code: "mesh.replayed" });
  });

  it("a signature made for another body or with the store down is refused", async () => {
    const forged = await sent(appOf(), OrdersMcp, { header: header('{"x":1}'), body: '{"x":2}' });
    const down = await sent(appOf({ down: true }), OrdersMcp, {
      header: header('{"jsonrpc":"2.0"}'),
    });

    expect(JSON.parse(forged.answer ?? "{}")).toMatchObject({ code: "mesh.request-mismatch" });
    expect(down.status).toBe(503);
    expect(JSON.parse(down.answer ?? "{}")).toMatchObject({
      code: "mesh.replay-check-unavailable",
    });
  });

  it("an application with no mesh leaves its requests to the host's session", async () => {
    const answer = await sent({}, OrdersMcp);

    expect(answer.admitted?.session).toEqual({});
  });

  it("a Strict mesh serves no endpoint its application does not list: it is not served", () => {
    @McpEndpoint({ name: "stray-mcp-expose", version: "1.0.0", tools: [] })
    class StrayMcp {}

    expect(() => servedEndpointOf(appOf() as never, StrayMcp)).toThrow(
      "[application.endpoint-unlisted] StrayMcp",
    );
    expect(() => servedEndpointOf(appOf() as never, OrdersMcp)).not.toThrow();
  });

  it("a signature made for another server's origin is refused here", async () => {
    const foreign = header('{"jsonrpc":"2.0"}', "https://evil.example/mcp/messages?sessionId=1");

    const answer = await sent(appOf(), OrdersMcp, { header: foreign, origin: ORIGIN });

    expect(answer.admitted).toBeUndefined();
    expect(answer.status).toBe(401);
    expect(JSON.parse(answer.answer ?? "{}")).toMatchObject({ code: "mesh.audience-mismatch" });
  });
});

@HttpAuthenticator()
class KeyAuthenticator {
  authenticate(request: { http: { headers: Record<string, string | string[] | undefined> } }) {
    const key = request.http.headers["x-key"];
    return typeof key === "string"
      ? HttpAuthResult.authenticated({ ownerId: key })
      : HttpAuthResult.unauthenticated("no key");
  }
}

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/** The listener on a local port; `publicUrl` is the origin the peers sign for. */
async function listening(mode: MeshInboundMode) {
  const base = appOf({ mode }) as Record<string, unknown>;
  const authenticator = new KeyAuthenticator();
  const app = Object.assign(base, {
    resolve: (token: unknown) =>
      token === Logger ? new SilentLogger() : token === Clock ? new SystemClock() : authenticator,
  });
  const server = createServer(
    mcpHttpListener(app as never, {
      endpoint: OrdersMcp,
      authenticator: KeyAuthenticator,
      publicUrl: ORIGIN,
      base: "/mcp",
    }),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/mcp`;
}

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
const MCP = { "content-type": "application/json", accept: "application/json, text/event-stream" };

describe("#1320: an MCP HTTP session admits each message by its own verified identity", () => {
  it("a session id reused by another caller (or none) is answered as no such session", async () => {
    const url = await listening(MeshInboundMode.AllowExternal);
    const opened = await fetch(url, {
      method: "POST",
      headers: { ...MCP, "x-key": "alice" },
      body: INIT,
    });
    const id = opened.headers.get("mcp-session-id") ?? "";
    await opened.text();
    expect(opened.status).toBe(200);

    const post = (headers: Record<string, string>) =>
      fetch(url, {
        method: "POST",
        headers: { ...MCP, "mcp-session-id": id, ...headers },
        body: PING,
      });

    expect((await post({ "x-key": "bob" })).status).toBe(404);
    expect((await post({})).status).toBe(401);
    expect((await post({ "x-key": "alice" })).status).toBe(200);
  });

  it("a signed peer's session takes only that peer's signed messages", async () => {
    const url = await listening(MeshInboundMode.Strict);
    const path = "/mcp";
    const signed = (
      body: string,
      as = { application: "a", key: caller.privateKey },
      method = "POST",
    ) => header(body, `${ORIGIN}${path}`, as, method);
    const opened = await fetch(url, {
      method: "POST",
      headers: { ...MCP, "x-agboss-mesh": signed(INIT) },
      body: INIT,
    });
    const id = opened.headers.get("mcp-session-id") ?? "";
    await opened.text();
    expect(opened.status).toBe(200);

    const post = (headers: Record<string, string>) =>
      fetch(url, {
        method: "POST",
        headers: { ...MCP, "mcp-session-id": id, ...headers },
        body: PING,
      });

    expect((await post({})).status).toBe(401);
    const otherPeer = signed(PING, { application: "c", key: other.privateKey });
    expect((await post({ "x-agboss-mesh": otherPeer })).status).toBe(404);
    const own = signed(PING);
    expect((await post({ "x-agboss-mesh": own })).status).toBe(200);
    expect((await post({ "x-agboss-mesh": own })).status).toBe(401); // a replay
  });

  it("a signature made for another server's origin is refused by the listener", async () => {
    const url = await listening(MeshInboundMode.Strict);
    const foreign = header(INIT, "https://evil.example/mcp");

    const answer = await fetch(url, {
      method: "POST",
      headers: { ...MCP, "x-agboss-mesh": foreign },
      body: INIT,
    });

    expect(answer.status).toBe(401);
    expect(await answer.json()).toMatchObject({ code: "mesh.audience-mismatch" });
  });

  it("a listener with no authenticator needs a Strict mesh with a tenant-propagating peer", () => {
    const app = Object.assign(appOf(), {
      resolve: (token: unknown) => (token === Logger ? new SilentLogger() : new SystemClock()),
    });

    expect(() => mcpHttpListener(app as never, { endpoint: OrdersMcp, publicUrl: ORIGIN })).toThrow(
      "[http.authenticator-required-for-tenant-context]",
    );
    expect(() =>
      mcpHttpListener(app as never, {
        endpoint: OrdersMcp,
        authenticator: KeyAuthenticator,
        publicUrl: "ftp://secret-host",
      }),
    ).toThrow(/^\[mcp.public-url-invalid\] [^]*$/);
  });
});
