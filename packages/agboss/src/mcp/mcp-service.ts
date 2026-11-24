import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { App } from "../app/types.js";
import type { Class } from "../components/injection.js";
import type { McpExposeOptions } from "./mcp-expose.decorator.js";
import {
  callIdOf,
  createSseTransport,
  mcpServerOptionsOf,
  type SseTransport,
} from "./mcp-service-helpers.js";
import { collectTools, type McpSessionOptions } from "./mcp-tool-registry.js";
import { dedupedMcpCall } from "./mcp-dedupe.js";
import { admitMcpCall } from "./mcp-mesh-gate.js";
import { admitMcpHttp } from "./mcp-http-gate.js";
import { ConfigError } from "../core/error-families/config-errors.js";
import { meshSettingsOf } from "../mesh/mesh-settings.js";
import { MeshInboundMode } from "../mesh/mesh.decorator.js";
import { MESH_REFUSAL_TEXT, MeshRefusalCode } from "../mesh/mesh-verification.js";
import { bodyWithin } from "../a2a/server/a2a-http-io.js";
import { kilobytes } from "../units/index.js";

/** What an `McpService` knows of where it is served (#1320). */
export interface McpServiceOptions {
  /**
   * The public URL the service is reached at (an environment text field in practice): its origin is what a
   * peer's signature must name, so a signature made for another server is no signature here. Required
   * whenever the application has a `@Mesh`.
   */
  readonly publicUrl?: string;
}

export interface McpSession {
  readonly sessionId: string;
  close(): Promise<void>;
}

/**
 * An app as an MCP server: `tools/list` and `tools/call` for the `@McpExpose` exports
 * (see `collectTools`), over stdio (`connectStdio`), SSE (`handleSse` + `handleMessage`) or any
 * SDK transport (`connect`, e.g. `InMemoryTransport` in tests).
 */
export class McpService {
  private readonly options: McpExposeOptions;
  private readonly activeTransports = new Map<
    string,
    { transport: SseTransport; session: McpSessionOptions }
  >();
  private readonly origin: string | undefined;

  constructor(
    private readonly app: App,
    private readonly config: Class,
    serving: McpServiceOptions = {},
  ) {
    const options = mcpServerOptionsOf(config);
    if (!options) {
      throw new Error(`${config.name} is not an @McpExpose`);
    }
    this.options = options;
    // a mesh that admits only peers gates every endpoint it serves: one the application does not
    // list has no gate — it is not served (#1320)
    const mesh = meshSettingsOf(app);
    this.origin = originOf(serving.publicUrl);
    if (mesh?.inboundMode === MeshInboundMode.Strict && !mesh.exposes.includes(config)) {
      throw new ConfigError.Environment({
        message: `[application.expose-unlisted] ${config.name} is not in @Application({ exposes }): under a Strict @Mesh an endpoint is served only through the mesh's gate`,
      });
    }
  }

  /**
   * The origin an HTTP request must have been signed for: under a `@Mesh` the service has to know it
   * (stdio and in-memory transports have no HTTP and need none) — without it nothing is served.
   */
  private originForHttp(): string | undefined {
    if (this.origin === undefined && meshSettingsOf(this.app) !== undefined) {
      throw new ConfigError.Environment({
        message: `[mcp.public-url-required] ${this.config.name}: under a @Mesh an MCP service over HTTP needs createMcpService(app, config, { publicUrl }): a peer's signature must be made for this server`,
      });
    }
    return this.origin;
  }

  private createServerInstance(session: McpSessionOptions): McpServer {
    const mcp = new McpServer(
      { name: this.options.name, version: this.options.version },
      { capabilities: { tools: {} } },
    );
    const { tools, handlers } = collectTools(this.app, this.options.exports, session);

    mcp.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
    mcp.server.setRequestHandler(CallToolRequestSchema, (request, extra) => {
      const { name, arguments: args, _meta } = request.params;
      const handler = handlers.get(name);
      if (!handler) {
        throw new Error(`Tool not found: ${name}`);
      }
      // the caller's mesh envelope (#398): a loop or a chain too long is refused before it runs
      const call = { tool: name, meta: _meta, args, peer: session.peer };
      const admission = admitMcpCall(this.app, call);
      if (!admission.isAdmitted) return admission.refusal;
      const callId = callIdOf(_meta);
      const run = () =>
        handler({
          args,
          signal: extra.signal,
          ...(callId === undefined ? {} : { callId }),
          ...(admission.inbound === undefined ? {} : { mesh: admission.inbound }),
          ...(admission.bodyHash === undefined ? {} : { bodyHash: admission.bodyHash }),
        });
      // a trusted call with a callId runs once (#398 PR 2b): a repeat gets the kept result
      const tenantId = session.tenant?.tenantId;
      return dedupedMcpCall(this.app, { peer: admission.peer, callId, tenantId }, run);
    });

    return mcp;
  }

  /**
   * Connects a new server instance to `transport` (any MCP SDK server transport); every call of
   * the session runs with `session` (its caller's owner and context values).
   */
  public async connect(transport: Transport, session: McpSessionOptions = {}): Promise<void> {
    await this.createServerInstance(session).connect(transport);
  }

  /**
   * Connects the MCP server over standard input/output (CLI usage).
   * Note: This blocks the process from exiting.
   */
  public async connectStdio(): Promise<void> {
    await this.connect(new StdioServerTransport());
  }

  /**
   * Starts an SSE session for an incoming HTTP GET request.
   * Note: You must provide a messageEndpoint (e.g. "/mcp/messages") where POSTs will be routed.
   * With a `@Mesh`, the request's `X-AGBoss-Mesh` header is checked first (`mcp-http-gate.ts`); a
   * refused request is answered there and `undefined` comes back.
   */
  public async handleSse(
    req: IncomingMessage,
    res: ServerResponse,
    messageEndpoint: string,
    session: McpSessionOptions = {},
  ): Promise<McpSession | undefined> {
    const admitted = await admitMcpHttp(
      this.app,
      this.config,
      { req, res, body: "" },
      session,
      this.originForHttp(),
    );
    if (admitted === undefined) return undefined;
    const served = admitted.session;
    const server = this.createServerInstance(served);
    const transport = createSseTransport(messageEndpoint, res);
    await server.connect(transport);

    this.activeTransports.set(transport.sessionId, { transport, session: served });

    res.on("close", () => {
      this.activeTransports.delete(transport.sessionId);
    });

    return {
      sessionId: transport.sessionId,
      close: async () => {
        await transport.close();
      },
    };
  }

  /**
   * Forwards a POSTed JSON-RPC message to the correct SSE session. Each message is admitted on its own
   * (#1320): with a `@Mesh` it carries its own signature, checked once against this request; a session
   * opened by a peer takes only that peer's signed messages, and any session takes only its own caller's
   * (`caller`: what the host's authenticator says of THIS request, as it did for `handleSse`) — a session
   * id someone else learned is no way into it.
   */
  public async handleMessage(
    req: IncomingMessage,
    res: ServerResponse,
    sessionId: string,
    parsedBody?: unknown,
    caller: McpSessionOptions = {},
  ): Promise<void> {
    const stored = this.activeTransports.get(sessionId);
    if (!stored) {
      res.statusCode = 404;
      res.end("Session not found");
      return;
    }
    if (meshSettingsOf(this.app) === undefined) {
      if (!isSameCaller(caller, stored.session)) {
        notFound(res);
        return;
      }
      await stored.transport.handlePostMessage(req, res, parsedBody);
      return;
    }
    const raw = await bodyWithin(req, res, kilobytes(1024));
    if (raw === undefined) return;
    // the message's own identity: from its verified decision alone, never the stored session's
    const admitted = await admitMcpHttp(
      this.app,
      this.config,
      { req, res, body: raw },
      {},
      this.originForHttp(),
    );
    if (admitted === undefined) return;
    const messageIdentity = admitted.session.peer === undefined ? caller : admitted.session;
    if (admitted.session.peer !== stored.session.peer) {
      mismatch(res);
      return;
    }
    if (!isSameCaller(messageIdentity, stored.session)) {
      notFound(res);
      return;
    }
    await stored.transport.handlePostMessage(req, res, JSON.parse(raw) as unknown);
  }
}

const mismatch = (res: ServerResponse): void => {
  const code = MeshRefusalCode.RequestMismatch;
  res
    .writeHead(403, { "content-type": "application/json" })
    .end(JSON.stringify({ code, error: MESH_REFUSAL_TEXT[code] }));
};

/** A caller that is not the session's is told what a stranger is: there is no such session. */
const notFound = (res: ServerResponse): void => {
  res.statusCode = 404;
  res.end("Session not found");
};

/** Whether `a` is the identity `b` was opened for: the same peer, owner and tenant. */
const isSameCaller = (a: McpSessionOptions, b: McpSessionOptions): boolean =>
  a.peer === b.peer && a.ownerId === b.ownerId && a.tenant?.tenantId === b.tenant?.tenantId;

/** The origin of a service's `publicUrl`; `undefined` when none is given. */
function originOf(publicUrl: string | undefined): string | undefined {
  if (publicUrl === undefined) return undefined;
  try {
    const url = new URL(publicUrl);
    if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
  } catch {
    // reported below, without the value
  }
  throw new ConfigError.Environment({
    message: "[mcp.public-url-invalid] createMcpService's publicUrl is not an absolute http(s) URL",
  });
}

export function createMcpService(app: App, config: Class, options?: McpServiceOptions): McpService {
  return new McpService(app, config, options);
}
