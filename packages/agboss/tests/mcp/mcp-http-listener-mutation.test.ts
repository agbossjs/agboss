/**
 * #1356 (mutation shard `a2a-server`): what an MCP HTTP listener answers, exactly — each refusal's status,
 * code and fixed text, the order of its checks, which of them end the request, how a session lives while a
 * stream of it is open, and what it does when it fails.
 */
import { IncomingMessage, ServerResponse, createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ExecutionStatus } from "../../src/app/types.js";
import { HttpAuthResult, type HttpAuthRequest } from "../../src/http/http-auth.js";
import { HttpAuthenticator } from "../../src/http/http-authenticator.js";
import { Clock, SystemClock } from "../../src/infrastructure/clock.js";
import { Logger, type LogEntry } from "../../src/infrastructure/logger.js";
import { McpEndpoint } from "../../src/mcp/mcp-endpoint.decorator.js";
import { mcpHttpListener, type McpHttpListenerOptions } from "../../src/mcp/mcp-http-listener.js";
import { rememberMeshSettings, type MeshSettings } from "../../src/mesh/mesh-settings.js";
import { MeshInboundMode } from "../../src/mesh/mesh.decorator.js";
import { MESH_REFUSAL_TEXT, MeshRefusalCode } from "../../src/mesh/mesh-verification.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { ms } from "../../src/units/index.js";
import { until } from "../helpers/until.js";
import { receiverOf } from "../helpers/mesh-http-peer.js";
import { ChatStart } from "../testing/fixtures/desk.workflow.js";

@McpEndpoint({ name: "listener-mcp", version: "1.0.0", tools: [ChatStart] })
class ListenerMcp {}

/** Whose request it is, from its headers: an owner, a tenant, both or none. */
@HttpAuthenticator()
class HeaderAuthenticator {
  static readonly asked: HttpAuthRequest[] = [];
  authenticate(request: HttpAuthRequest) {
    HeaderAuthenticator.asked.push(request);
    const header = (name: string): string | undefined => {
      const value = request.http.headers[name];
      return typeof value === "string" ? value : undefined;
    };
    const ownerId = header("x-owner");
    const tenantId = header("x-tenant");
    if (ownerId === undefined && tenantId === undefined)
      return HttpAuthResult.unauthenticated("no caller");
    return HttpAuthResult.authenticated({
      ...(ownerId === undefined ? {} : { ownerId }),
      ...(tenantId === undefined ? {} : { tenant: { tenantId } }),
    });
  }
}

class RecordingLogger extends Logger {
  readonly entries: LogEntry[] = [];
  write(entry: LogEntry): void {
    this.entries.push(entry);
  }
}

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
  HeaderAuthenticator.asked.length = 0;
});

interface Setup extends Partial<McpHttpListenerOptions> {
  /** The application's mesh, as `@Mesh` makes it: none (no `rememberMeshSettings`) unless given. */
  readonly mesh?: {
    isBaseTenantContext: boolean;
    inboundMode: MeshInboundMode;
    propagates?: boolean;
  };
  readonly clock?: Clock;
}

/** An application and a listener made for it; the settings the application reads can be changed after. */
async function listening(setup: Setup = {}) {
  const { mesh, clock = new SystemClock(), ...options } = setup;
  const logger = new RecordingLogger();
  const errors: unknown[] = [];
  const app = {
    name: "listener-app",
    resume: () => Promise.resolve({ status: ExecutionStatus.Finished, output: { ok: true } }),
    resolve: (token: unknown) =>
      token === Logger ? logger : token === Clock ? clock : new (token as new () => object)(),
  };
  const state = {
    settings: undefined as MeshSettings | undefined,
    broken: false,
  };
  if (mesh !== undefined) {
    state.settings = {
      ...receiverOf().settings,
      application: "listener",
      endpoints: [ListenerMcp],
      isBaseTenantContext: mesh.isBaseTenantContext,
      inboundMode: mesh.inboundMode,
      peers: new Map(
        mesh.propagates === true
          ? [["a", { allowEndpoints: undefined, propagateTenant: true }]]
          : [],
      ),
    };
    rememberMeshSettings(app, () => {
      if (state.broken) throw new Error("the mesh settings are gone");
      return state.settings;
    });
  }
  const handler = mcpHttpListener(app as never, {
    endpoint: ListenerMcp,
    publicUrl: "https://listener.example",
    base: "/mcp",
    ...("authenticator" in setup || options.allowAnonymous === true
      ? {}
      : { authenticator: HeaderAuthenticator }),
    onError: (error) => {
      errors.push(error);
    },
    ...options,
  });
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return { origin, url: `${origin}${options.base ?? "/mcp"}`, handler, errors, logger, state };
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

/** The answer's status and JSON body. */
async function answered(response: Response): Promise<{ status: number; body: unknown }> {
  const text = await response.text();
  return { status: response.status, body: text === "" ? undefined : (JSON.parse(text) as unknown) };
}

const OWNER = { "x-owner": "dana" };

/** A GET that carries a body, which `fetch` will not send. */
function getWithBody(url: string, body: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const headers = { ...MCP, ...OWNER, "content-length": String(Buffer.byteLength(body)) };
    const sent = request(url, { method: "GET", headers }, (res) => {
      let text = "";
      res.on("data", (chunk: Buffer) => {
        text += chunk.toString("utf8");
      });
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) as unknown });
      });
    });
    sent.on("error", reject);
    sent.end(body);
  });
}

describe("where the listener serves", () => {
  it("only its base: another path is 404 with its code and text, a query string is no part of the path", async () => {
    const { origin, url } = await listening();

    expect(await answered(await post(`${origin}/other`, OWNER, INIT))).toEqual({
      status: 404,
      body: { code: "mcp.not-found", error: "there is nothing here" },
    });
    expect((await post(`${url}?x=1`, OWNER, INIT)).status).toBe(200);
  });

  it("the root when no base is given", async () => {
    const { origin } = await listening({ base: undefined as never });

    expect((await post(`${origin}/`, OWNER, INIT)).status).toBe(200);
    expect((await post(`${origin}/mcp`, OWNER, INIT)).status).toBe(404);
  });
});

describe("what a request that names no session is", () => {
  it("a GET opens nothing, even with a body: no such session, 404 with its code and text", async () => {
    const { url, errors } = await listening();

    const plain = await answered(await fetch(url, { headers: { ...MCP, ...OWNER } }));
    const withBody = await getWithBody(url, "not json");

    expect(plain).toEqual({
      status: 404,
      body: { code: "mcp.session-not-found", error: "there is no such session" },
    });
    expect(withBody).toEqual(plain);
    expect(errors).toEqual([]);
  });

  it("a session id nobody opened is the same 404, and nothing is raised", async () => {
    const { url, errors } = await listening();

    expect(
      await answered(await post(url, { ...OWNER, "mcp-session-id": "no-such-id" }, PING)),
    ).toEqual({
      status: 404,
      body: { code: "mcp.session-not-found", error: "there is no such session" },
    });
    expect(errors).toEqual([]);
  });

  it("a body that is no JSON is 400 with its code and text, before any session is looked at", async () => {
    const { url, errors } = await listening();

    expect(await answered(await post(url, OWNER, "{not json"))).toEqual({
      status: 400,
      body: { code: "mcp.body-not-json", error: "the request body is not JSON" },
    });
    expect(errors).toEqual([]);
  });

  it("a body over the limit is 413, nothing more is done", async () => {
    const { url, errors } = await listening({ maxBodySize: 20 as never });

    expect((await post(url, OWNER, INIT)).status).toBe(413);
    expect(errors).toEqual([]);
  });
});

describe("who calls", () => {
  it("an authenticator that does not know the caller ends the request: its 401, nothing more is done", async () => {
    const { url, errors } = await listening({ authenticator: HeaderAuthenticator });

    expect((await post(url, {}, INIT)).status).toBe(401);
    expect(errors).toEqual([]);
  });

  it("an authenticator is asked for the request's own method", async () => {
    const { url } = await listening({ authenticator: HeaderAuthenticator });

    await post(url, OWNER, INIT);
    await fetch(url, { headers: { ...MCP, ...OWNER } });

    expect(HeaderAuthenticator.asked.map(({ operation }) => operation)).toEqual(["POST", "GET"]);
  });

  it("a request with no method at all is asked for as a POST", async () => {
    const { handler } = await listening({ authenticator: HeaderAuthenticator });
    const req = Object.assign(new IncomingMessage(new Socket()), {
      url: "/mcp",
      headers: { "x-owner": "dana" },
    });
    const res = new ServerResponse(req);

    handler(req, res);
    await until(() => HeaderAuthenticator.asked.length > 0, "the authenticator is asked");

    expect(HeaderAuthenticator.asked[0]?.operation).toBe("POST");
  });

  it("an application with a tenantContext serves no caller without a tenant: 403 with its code and text", async () => {
    const { url, errors } = await listening({
      authenticator: HeaderAuthenticator,
      mesh: { isBaseTenantContext: false, inboundMode: MeshInboundMode.AllowExternal },
    });

    expect(await answered(await post(url, OWNER, INIT))).toEqual({
      status: 403,
      body: {
        code: "mcp.caller-anonymous",
        error: "the caller names no tenant: this application serves only a caller with one",
      },
    });
    expect((await post(url, { ...OWNER, "x-tenant": "acme" }, INIT)).status).toBe(200);
    expect(errors).toEqual([]);
  });

  it("an application with no tenantContext of its own serves a caller without one", async () => {
    const { url } = await listening({
      authenticator: HeaderAuthenticator,
      mesh: { isBaseTenantContext: true, inboundMode: MeshInboundMode.AllowExternal },
    });

    expect((await post(url, OWNER, INIT)).status).toBe(200);
  });

  it("a signed-peers-only listener refuses an unsigned request with the mesh's code and text, nothing more is done", async () => {
    const { url, errors } = await listening({
      authenticator: undefined,
      mesh: { isBaseTenantContext: false, inboundMode: MeshInboundMode.Strict, propagates: true },
    });

    expect(await answered(await post(url, OWNER, INIT))).toEqual({
      status: 401,
      body: {
        code: MeshRefusalCode.SignatureMissing,
        error: MESH_REFUSAL_TEXT[MeshRefusalCode.SignatureMissing],
      },
    });
    expect(errors).toEqual([]);
  });

  it("a listener with no authenticator that finds the mesh now admits external callers refuses them: 401", async () => {
    const { url, state, errors } = await listening({
      authenticator: undefined,
      mesh: { isBaseTenantContext: false, inboundMode: MeshInboundMode.Strict, propagates: true },
    });
    if (state.settings === undefined) throw new Error("no settings");
    state.settings = { ...state.settings, inboundMode: MeshInboundMode.AllowExternal };

    expect(await answered(await post(url, OWNER, INIT))).toEqual({
      status: 401,
      body: {
        code: "mcp.caller-unauthenticated",
        error: "the request is not from a signed mesh peer",
      },
    });
    expect(errors).toEqual([]);
  });

  it("anonymous callers are served only when the listener was made to", async () => {
    const { url } = await listening({
      allowAnonymous: true,
      mesh: { isBaseTenantContext: true, inboundMode: MeshInboundMode.AllowExternal },
    });

    expect((await post(url, {}, INIT)).status).toBe(200);
  });
});

describe("a failure past the listener's own answers", () => {
  it("is 503 with its code and text, logged by its class with a fixed message, told to onError, never its text on the wire", async () => {
    const { url, state, logger, errors } = await listening({
      mesh: { isBaseTenantContext: true, inboundMode: MeshInboundMode.AllowExternal },
      allowAnonymous: true,
    });
    state.broken = true;

    expect(await answered(await post(url, OWNER, INIT))).toEqual({
      status: 503,
      body: { code: "mcp.listener-failed", error: "the MCP server is not available" },
    });
    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]).toMatchObject({
      level: "error",
      code: "mcp.listener-failed",
      message: "the MCP listener failed to serve a request: Error",
    });
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("the mesh settings are gone");
  });
});

describe("a session while a request of it is open", () => {
  it("is not closed for being idle: its stream is a request in flight, and the idle clock runs again once it ends", async () => {
    const clock = new VirtualClock();
    const { url } = await listening({
      authenticator: HeaderAuthenticator,
      sessionIdleTimeout: ms(150),
      clock,
    });
    const opened = await post(url, OWNER, INIT);
    const id = opened.headers.get("mcp-session-id") ?? "";
    await opened.text();
    const stream = await fetch(url, {
      headers: { accept: "text/event-stream", "mcp-session-id": id, ...OWNER },
    });
    expect(stream.status).toBe(200);

    await clock.advance(ms(1_000));
    const during = await post(url, { ...OWNER, "mcp-session-id": id }, PING);
    expect(during.status).toBe(200);
    await during.text();

    await stream.body?.cancel();
    await until(
      () => HeaderAuthenticator.asked.length >= 3,
      "the stream's request has been judged",
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    await clock.advance(ms(1_000));
    const after = await post(url, { ...OWNER, "mcp-session-id": id }, PING);
    expect(after.status).toBe(404);
    await after.text();
  });
});

describe("a burst of initializes from one caller over the caller's cap", () => {
  it("passes no more sessions than the cap allows", async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    @HttpAuthenticator()
    class SlowAuthenticator {
      async authenticate() {
        await gate;
        return HttpAuthResult.authenticated({ ownerId: "dana" });
      }
    }
    const { url } = await listening({
      authenticator: SlowAuthenticator,
      maxSessionsPerCaller: 2,
    });

    const sends = Array.from({ length: 4 }, () => post(url, {}, INIT));
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();
    const statuses = (await Promise.all(sends)).map((answer) => answer.status).sort();

    expect(statuses).toEqual([200, 200, 429, 429]);
  });
});
