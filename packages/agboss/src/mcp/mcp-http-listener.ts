import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  listenerAuthenticatorOf,
  notifyHost,
  writeRejection,
  admitCaller,
} from "../a2a/a2a-caller-gate.js";
import { bodyWithin } from "../a2a/server/a2a-http-io.js";
import type { App } from "../app/types.js";
import type { Class } from "../components/injection.js";
import { ConfigError } from "../core/error-families/config-errors.js";
import type { HttpCaller } from "../http/http-auth.js";
import { Clock } from "../infrastructure/clock.js";
import { frameworkLogOf, Logger } from "../infrastructure/logger.js";
import { MESH_REFUSAL_TEXT, MeshRefusalCode } from "../mesh/mesh-verification.js";
import { kilobytes, type Bytes } from "../units/index.js";
import { isAnonymous, isSameCaller } from "./mcp-session-identity.js";
import { admitMcpHttp } from "./mcp-http-gate.js";
import type { McpEndpointOptions } from "./mcp-endpoint.decorator.js";
import { mcpServerOf, servedEndpointOf } from "./mcp-server-instance.js";
import type { McpSessionOptions } from "./mcp-service-helpers.js";

/**
 * `mcpHttpListener` (#1319): an `@McpEndpoint` over MCP's Streamable HTTP, symmetric with
 * `a2aHttpListener`. Every request is admitted on its own, before anything of it is read as MCP: a
 * signed mesh peer (`X-AGBoss-Mesh`, verified against this very request, admitted once, allowed this
 * endpoint) or a caller the `@HttpAuthenticator` judges. A session belongs to the identity that
 * opened it: any other caller's request naming its id is answered "no such session", and a peer's
 * session takes only that peer's signed messages.
 */

/** `mcpHttpListener(app, { endpoint, publicUrl, authenticator?, base?, maxBodySize?, onError? })`. */
export interface McpHttpListenerOptions {
  /** The `@McpEndpoint` served, listed in `@Application({ exposes })` under a `@Mesh`. */
  readonly endpoint: Class;
  /**
   * Who calls (an `@HttpAuthenticator` listed in `@Application({ services })`). Optional only for an
   * application whose `@Mesh` is `Strict` with a peer that has `propagateTenant` and whose tenant
   * context is the base one (`[http.authenticator-required-for-tenant-context]` otherwise).
   */
  readonly authenticator?: Class;
  /** Where callers reach the listener, an absolute http(s) URL without the `base`: a peer's signature must name its origin. */
  readonly publicUrl: string;
  /** The path it serves (`"/mcp"`); default `"/"`. */
  readonly base?: string;
  /** The largest request body read: over it `413`, nothing run. By default `kilobytes(1024)`. */
  readonly maxBodySize?: Bytes;
  /** Told of an error the listener or the authenticator hit, with the request: its text never goes on the wire. */
  readonly onError?: (error: unknown, req: IncomingMessage) => void;
}

const SESSION_HEADER = "mcp-session-id";
const UNAVAILABLE = { code: "mcp.listener-failed", error: "the MCP server is not available" };
const NO_SESSION = { code: "mcp.session-not-found", error: "there is no such session" };
const NOT_JSON = { code: "mcp.body-not-json", error: "the request body is not JSON" };

interface OpenSession {
  readonly transport: StreamableHTTPServerTransport;
  readonly identity: McpSessionOptions;
}

const ANONYMOUS = {
  code: "mcp.caller-anonymous",
  error: "the caller names no owner: an MCP session is kept only for an identified caller",
};

/** What a request's verified identity is passed on as to the server: the SDK's `req.auth`, read back per message. */
const verified = new WeakMap<AuthInfo, McpSessionOptions>();

/** Marks `req` as carrying `identity`, for the server that handles it. */
function carrying(req: IncomingMessage, identity: McpSessionOptions): void {
  const info: AuthInfo = { token: "", clientId: "", scopes: [] };
  verified.set(info, identity);
  (req as IncomingMessage & { auth?: AuthInfo }).auth = info;
}

/** The identity of the message being served: the one its own request was verified as; none is refused. */
function messageIdentity(extra: { readonly authInfo?: AuthInfo }): McpSessionOptions {
  const identity = extra.authInfo === undefined ? undefined : verified.get(extra.authInfo);
  if (identity === undefined) throw new Error("an MCP message arrived with no verified identity");
  return identity;
}

/** The identity a host's `@HttpAuthenticator` gave, as a connection's session. */
const sessionOf = (caller: HttpCaller): McpSessionOptions => ({
  ownerId: caller.ownerId,
  tenant: caller.tenant,
  execution: caller.execution,
  peer: caller.peer,
});

/** The origin of `publicUrl`: an absolute http(s) URL, else the listener is not made. */
function originOf(publicUrl: string): string {
  try {
    const url = new URL(publicUrl);
    if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
  } catch {
    // reported below, without the value
  }
  throw new ConfigError.Environment({
    message: "[mcp.public-url-invalid] mcpHttpListener's publicUrl is not an absolute http(s) URL",
  });
}

const headerOf = (req: IncomingMessage, name: string): string | undefined => {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

/** The pathname of a request's URL. */
const pathOf = (req: IncomingMessage): string => (req.url ?? "/").split("?")[0] ?? "/";

/** What a listener serves with. */
interface Listening {
  readonly app: App;
  readonly options: McpHttpListenerOptions;
  readonly served: McpEndpointOptions;
  readonly authenticator: ReturnType<typeof listenerAuthenticatorOf>;
  readonly origin: string;
  readonly base: string;
  readonly maxBody: Bytes;
  readonly log: ReturnType<typeof frameworkLogOf>;
  readonly sessions: Map<string, OpenSession>;
}

/** The caller of this request: a verified peer, the authenticator's caller, or `undefined` once answered. */
async function identityOf(
  l: Listening,
  request: { req: IncomingMessage; res: ServerResponse; raw: string },
): Promise<McpSessionOptions | undefined> {
  const { req, res, raw } = request;
  // the signature before everything it claims; each request is judged on its own
  const admitted = await admitMcpHttp(
    l.app,
    l.options.endpoint,
    { req, res, body: raw },
    {},
    l.origin,
  );
  if (admitted === undefined) return undefined;
  if (admitted.session.peer !== undefined) return admitted.session;
  if (l.authenticator === undefined) {
    const code = MeshRefusalCode.SignatureMissing;
    writeRejection(res, 401, { code, error: MESH_REFUSAL_TEXT[code] });
    return undefined;
  }
  const asking = { http: req, operation: req.method ?? "POST" };
  const gate = await admitCaller(l.authenticator.instance, asking, res, l.log, l.options.onError);
  if (!gate.isAdmitted) return undefined;
  const identity = sessionOf(gate.caller);
  if (isAnonymous(identity)) {
    // two anonymous callers are one to nothing: no session is opened or continued for either
    writeRejection(res, 403, ANONYMOUS);
    return undefined;
  }
  return identity;
}

/** A new session of `identity`: its own server, kept from the SDK's `initialize` until it closes. */
function opened(l: Listening, identity: McpSessionOptions): StreamableHTTPServerTransport {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      l.sessions.set(id, { transport, identity });
    },
  });
  transport.onclose = () => {
    if (transport.sessionId !== undefined) l.sessions.delete(transport.sessionId);
  };
  void mcpServerOf(l.app, l.served, messageIdentity).connect(transport);
  return transport;
}

/** The transport of this request: the session's, or a new one for the request that opens it. */
function transportOf(
  l: Listening,
  request: { req: IncomingMessage; res: ServerResponse },
  identity: McpSessionOptions,
): StreamableHTTPServerTransport | undefined {
  const { req, res } = request;
  const id = headerOf(req, SESSION_HEADER);
  if (id === undefined && req.method === "POST") return opened(l, identity);
  const open = id === undefined ? undefined : l.sessions.get(id);
  if (open === undefined || !isSameCaller(identity, open.identity)) {
    // a stranger holding an id is told what any other id is told
    writeRejection(res, 404, NO_SESSION);
    return undefined;
  }
  return open.transport;
}

/** Serves one request. */
async function serve(l: Listening, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (pathOf(req) !== l.base) {
    writeRejection(res, 404, { code: "mcp.not-found", error: "there is nothing here" });
    return;
  }
  const raw = req.method === "POST" ? await bodyWithin(req, res, l.maxBody) : "";
  if (raw === undefined) return;
  const identity = await identityOf(l, { req, res, raw });
  if (identity === undefined) return;
  const body = raw === "" ? undefined : jsonOf(raw);
  if (raw !== "" && body === undefined) {
    writeRejection(res, 400, NOT_JSON);
    return;
  }
  const transport = transportOf(l, { req, res }, identity);
  if (transport === undefined) return;
  carrying(req, identity); // this message runs as its own caller, equal to the session's opener
  await transport.handleRequest(req, res, body);
}

/** `http.createServer(mcpHttpListener(app, { endpoint, authenticator, publicUrl, base }))`. */
export function mcpHttpListener(
  app: App,
  options: McpHttpListenerOptions,
): (req: IncomingMessage, res: ServerResponse) => void {
  const listening: Listening = {
    app,
    options,
    served: servedEndpointOf(app, options.endpoint),
    authenticator: listenerAuthenticatorOf(app, options.authenticator),
    origin: originOf(options.publicUrl),
    base: options.base ?? "/",
    maxBody: options.maxBodySize ?? kilobytes(1024),
    log: frameworkLogOf(app.resolve(Logger), app.resolve(Clock)),
    sessions: new Map(),
  };
  return (req, res) => {
    serve(listening, req, res).catch((error: unknown) => {
      // a failure past the listener's own answers: logged by its class, never its text on the wire
      const name = error instanceof Error ? error.name : typeof error;
      listening.log.error(
        "mcp.listener-failed",
        `the MCP listener failed to serve a request: ${name}`,
      );
      notifyHost(options.onError, error, req);
      if (res.headersSent) res.destroy();
      else writeRejection(res, 503, UNAVAILABLE);
    });
  };
}

/** The JSON of a body; `undefined` when it is none. */
function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
