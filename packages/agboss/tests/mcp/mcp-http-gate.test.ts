/**
 * #1320 (security): the mesh's gate of every HTTP request to an MCP endpoint — what `McpService`'s
 * `handleSse` / `handleMessage` pass before anything of the request is read as MCP: an unsigned request
 * to a Strict endpoint, an endpoint outside the peer's `allowEndpoints`, a replayed signature and a
 * request made for another body are refused with a code and a fixed text, a verified peer owns its calls.
 */
import { generateKeyPairSync } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { admitMcpHttp } from "../../src/mcp/mcp-http-gate.js";
import { McpExpose } from "../../src/mcp/mcp-expose.decorator.js";
import { McpService } from "../../src/mcp/mcp-service.js";
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

@McpExpose({ name: "orders-mcp-expose", version: "1.0.0", exports: [] })
class OrdersMcp {}
@McpExpose({ name: "admin-mcp-expose", version: "1.0.0", exports: [] })
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
    exposes: [OrdersMcp, AdminMcp],
  } as unknown as MeshSettings;
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
  } as unknown as IncomingMessage;
  const written: { status?: number; body?: string } = {};
  const res = {
    writeHead(status: number) {
      written.status = status;
      return this;
    },
    end(text: string) {
      written.body = text;
    },
  } as unknown as ServerResponse;
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

  it("a Strict mesh serves no endpoint its application does not list: the service is not made", () => {
    @McpExpose({ name: "stray-mcp-expose", version: "1.0.0", exports: [] })
    class StrayMcp {}

    expect(() => new McpService(appOf() as never, StrayMcp)).toThrow(
      "[application.expose-unlisted] StrayMcp",
    );
    expect(() => new McpService(appOf() as never, OrdersMcp, { publicUrl: ORIGIN })).not.toThrow();
  });

  it("a signature made for another server's origin is refused here", async () => {
    const foreign = header('{"jsonrpc":"2.0"}', "https://evil.example/mcp/messages?sessionId=1");

    const answer = await sent(appOf(), OrdersMcp, { header: foreign, origin: ORIGIN });

    expect(answer.admitted).toBeUndefined();
    expect(answer.status).toBe(401);
    expect(JSON.parse(answer.answer ?? "{}")).toMatchObject({ code: "mesh.audience-mismatch" });
  });

  it("under a @Mesh an HTTP session is not served without a publicUrl; a bad publicUrl is no service", async () => {
    const service = new McpService(appOf() as never, OrdersMcp);
    const req = { method: "GET", url: "/mcp/sse", headers: {} } as unknown as IncomingMessage;

    await expect(service.handleSse(req, {} as ServerResponse, "/mcp/messages")).rejects.toThrow(
      "[mcp.public-url-required]",
    );
    expect(
      () => new McpService(appOf() as never, OrdersMcp, { publicUrl: "ftp://secret-host" }),
    ).toThrow(/^\[mcp.public-url-invalid\] [^]*$/);
  });
});

/** The SSE end of a service: a session opened by `opener`, and its POSTs. */
async function opened(
  opener: { headerOf?: string; session?: object; mode?: MeshInboundMode } = {},
) {
  const app = appOf({ mode: opener.mode });
  const service = new McpService(app as never, OrdersMcp, { publicUrl: ORIGIN });
  const open = {
    method: "GET",
    url: "/mcp/sse",
    headers: opener.headerOf === undefined ? {} : { "x-agboss-mesh": opener.headerOf },
  } as unknown as IncomingMessage;
  const sse = {
    writeHead() {
      return this;
    },
    write: () => true,
    on: () => sse,
    end: () => undefined,
  } as unknown as ServerResponse;
  const session = await service.handleSse(open, sse, "/mcp/messages", opener.session);
  const forwarded = vi.fn(() => Promise.resolve());
  const kept = (
    service as unknown as {
      activeTransports: Map<string, { transport: { handlePostMessage: unknown } }>;
    }
  ).activeTransports.get(session?.sessionId ?? "");
  if (kept) kept.transport.handlePostMessage = forwarded;
  return { service, session, forwarded };
}

/** One POST to the session, and what was answered. */
async function posted(
  service: McpService,
  sessionId: string,
  options: { header?: string; caller?: object } = {},
) {
  const body = '{"jsonrpc":"2.0"}';
  const req = Object.assign(Readable.from([Buffer.from(body)]), {
    method: "POST",
    url: "/mcp/messages?sessionId=1",
    headers: options.header === undefined ? {} : { "x-agboss-mesh": options.header },
  }) as unknown as IncomingMessage;
  const written: { status?: number } = {};
  const res = {
    set statusCode(value: number) {
      written.status = value;
    },
    writeHead(status: number) {
      written.status = status;
      return this;
    },
    end: () => undefined,
  } as unknown as ServerResponse;
  await service.handleMessage(req, res, sessionId, undefined, options.caller);
  return written.status;
}

describe("#1320: an MCP session admits each message by its own verified identity", () => {
  const body = '{"jsonrpc":"2.0"}';

  it("an unsigned message on a session a peer opened is refused, nothing forwarded", async () => {
    const { service, session, forwarded } = await opened({
      headerOf: header("", OPEN_URL, undefined, "GET"),
    });

    expect(await posted(service, session?.sessionId ?? "")).toBe(401);
    expect(forwarded).not.toHaveBeenCalled();
  });

  it("a message signed by another peer is refused, nothing forwarded", async () => {
    const { service, session, forwarded } = await opened({
      headerOf: header("", OPEN_URL, undefined, "GET"),
    });
    const foreign = header(body, undefined, { application: "c", key: other.privateKey });

    expect(await posted(service, session?.sessionId ?? "", { header: foreign })).toBe(403);
    expect(forwarded).not.toHaveBeenCalled();
  });

  it("the opening peer's own signed message is forwarded, once", async () => {
    const { service, session, forwarded } = await opened({
      headerOf: header("", OPEN_URL, undefined, "GET"),
    });
    const signed = header(body);

    expect(await posted(service, session?.sessionId ?? "", { header: signed })).toBeUndefined();
    expect(forwarded).toHaveBeenCalledTimes(1);
    expect(await posted(service, session?.sessionId ?? "", { header: signed })).toBe(401);
    expect(forwarded).toHaveBeenCalledTimes(1);
  });

  it("a peer's signed message on a session a host caller opened is refused", async () => {
    const { service, session, forwarded } = await opened({
      mode: MeshInboundMode.AllowExternal,
      session: { ownerId: "alice" },
    });

    expect(await posted(service, session?.sessionId ?? "", { header: header(body) })).toBe(403);
    expect(forwarded).not.toHaveBeenCalled();
  });

  it("a session id reused by another caller is refused as no session; its own caller passes", async () => {
    const { service, session, forwarded } = await opened({
      mode: MeshInboundMode.AllowExternal,
      session: { ownerId: "alice", tenant: { tenantId: "t1" } },
    });
    const id = session?.sessionId ?? "";

    expect(
      await posted(service, id, { caller: { ownerId: "bob", tenant: { tenantId: "t1" } } }),
    ).toBe(404);
    expect(
      await posted(service, id, { caller: { ownerId: "alice", tenant: { tenantId: "t2" } } }),
    ).toBe(404);
    expect(await posted(service, id)).toBe(404);
    expect(forwarded).not.toHaveBeenCalled();

    await posted(service, id, { caller: { ownerId: "alice", tenant: { tenantId: "t1" } } });
    expect(forwarded).toHaveBeenCalledTimes(1);
  });
});
