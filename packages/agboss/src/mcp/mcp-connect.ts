import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  JSONRPCMessageSchema,
  type JSONRPCMessage,
  type MessageExtraInfo,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import type { App } from "../app/types.js";
import type { HasTenantContext } from "../app/tenant-args.js";
import type { Class } from "../components/injection.js";
import { mcpServerOf, servedEndpointOf } from "./mcp-server-instance.js";
import type { McpSessionOptions } from "./mcp-tool-registry.js";

/**
 * `connectMcpStdio` / `connectMcp` (#1319): an `@McpEndpoint` served over a transport that is one
 * connection — standard input/output, or any transport of the MCP SDK's server side (an in-memory
 * pair in tests). The connection's caller is the host's: `session` is its owner, tenant and context
 * values; it never names a mesh peer (only `mcpHttpListener`, once it verified a signature, does).
 */

/** A message of the MCP wire (JSON-RPC 2.0), as AGBoss sees it: no SDK type in the public surface. */
export type McpWireMessage = Readonly<Record<string, unknown>>;

/**
 * A transport of one MCP connection, structurally: what an MCP SDK server transport already is
 * (`StdioServerTransport`, `InMemoryTransport`, …), so one is passed without importing the SDK's type.
 */
export interface McpWireTransport {
  start(): Promise<void>;
  send(message: McpWireMessage, options?: unknown): Promise<void>;
  close(): Promise<void>;
  onclose?(): void;
  onerror?(error: Error): void;
  onmessage?(message: McpWireMessage, extra?: unknown): void;
  sessionId?: string;
}

/** An open connection: closed once, by `close()` or `await using`. */
export interface McpConnection {
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

/** The session of a connection: required, with its tenant, while the application declares a `tenantContext`. */
export type McpConnectionSession<TApp> =
  HasTenantContext<TApp> extends false
    ? { readonly session?: McpSessionOptions }
    : {
        readonly session: McpSessionOptions & {
          readonly tenant: NonNullable<McpSessionOptions["tenant"]>;
        };
      };

/** `connectMcpStdio(app, { endpoint, session? })`. */
export type McpStdioOptions<TApp> = { readonly endpoint: Class } & McpConnectionSession<TApp>;

/** `connectMcp(app, { endpoint, transport, session? })`. */
export type McpConnectOptions<TApp> = McpStdioOptions<TApp> & {
  readonly transport: McpWireTransport;
};

/** The wire transport as the SDK's server takes it: what it receives is parsed as JSON-RPC, or dropped. */
class WireAdapter implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;

  constructor(private readonly wire: McpWireTransport) {}

  get sessionId(): string | undefined {
    return this.wire.sessionId;
  }

  start(): Promise<void> {
    this.wire.onclose = () => this.onclose?.();
    this.wire.onerror = (error) => this.onerror?.(error);
    this.wire.onmessage = (message, extra) => {
      const parsed = JSONRPCMessageSchema.safeParse(message);
      if (parsed.success) this.onmessage?.(parsed.data, extra as MessageExtraInfo | undefined);
    };
    return this.wire.start();
  }

  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    return this.wire.send(message, options);
  }

  close(): Promise<void> {
    return this.wire.close();
  }
}

/** Serves `endpoint` over `transport` until the connection is closed. */
export async function connectMcp<TApp>(
  app: App<TApp>,
  options: McpConnectOptions<TApp>,
): Promise<McpConnection> {
  const served = servedEndpointOf(app, options.endpoint);
  // only the declared values: a `peer` a JavaScript host adds is not carried (a peer is proved by a signature)
  const { ownerId, tenant, execution } = options.session ?? {};
  const session: McpSessionOptions = { ownerId, tenant, execution };
  const server = mcpServerOf(app, served, () => session);
  await server.connect(new WireAdapter(options.transport));
  const close = () => server.close();
  return { close, [Symbol.asyncDispose]: close };
}

/** Serves `endpoint` over the process's standard input and output (a CLI an MCP client starts). */
export function connectMcpStdio<TApp>(
  app: App<TApp>,
  options: McpStdioOptions<TApp>,
): Promise<McpConnection> {
  // the SDK's own stdio transport is a wire transport: the adapter parses what it reads all the same
  const stdio: McpWireTransport = new StdioServerTransport();
  return connectMcp(app, { ...options, transport: stdio });
}
