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

  constructor(
    private readonly app: App,
    config: Class,
  ) {
    const options = mcpServerOptionsOf(config);
    if (!options) {
      throw new Error(`${config.name} is not an @McpExpose`);
    }
    this.options = options;
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
   */
  public async handleSse(
    res: ServerResponse,
    messageEndpoint: string,
    session: McpSessionOptions = {},
  ): Promise<McpSession> {
    const server = this.createServerInstance(session);
    const transport = createSseTransport(messageEndpoint, res);
    await server.connect(transport);

    this.activeTransports.set(transport.sessionId, { transport, session });

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
   * Forwards a POSTed JSON-RPC message to the correct SSE session.
   */
  public async handleMessage(
    req: IncomingMessage,
    res: ServerResponse,
    sessionId: string,
    parsedBody?: unknown,
  ): Promise<void> {
    const session = this.activeTransports.get(sessionId);
    if (!session) {
      res.statusCode = 404;
      res.end("Session not found");
      return;
    }
    await session.transport.handlePostMessage(req, res, parsedBody);
  }
}

export function createMcpService(app: App, config: Class): McpService {
  return new McpService(app, config);
}
