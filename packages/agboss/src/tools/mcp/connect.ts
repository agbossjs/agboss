import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { McpTransport, type McpServerConfig } from "../../config/mcp-server-config.js";
import { McpError } from "../../core/error-families/remote-errors.js";
import { mergedHeaders, resolvedServerOf, type Env, type ResolvedMcpServer } from "./resolve.js";
import { schemaDifferences } from "./compat.js";
import { callIdentityOf } from "./call-identity.js";
import type { McpCaller, McpFacade, McpServerHandle } from "./facade.js";
import { MESH_META_KEY, MESH_REPORT_META_KEY, TRACEPARENT } from "../../mesh/mesh-envelope.js";
import { outboundMeshOf, type OutboundMesh } from "../../mesh/outbound-mesh.js";
import { takeRunReport } from "../../mesh/mesh-report.js";
import { signedFetch } from "./signed-fetch.js";
import { meshHttpHeaderOf, type OutboundHttpRequest } from "../../mesh/outbound-http.js";
import type { ApplicationContext } from "../../flow/context/application-context.js";

/** What a server's handshake says of this application. */
export interface McpIdentity {
  readonly name: string;
  readonly version: string;
  /** The application's context: its mesh signs the handshakes before any execution runs (#1320). */
  readonly application?: ApplicationContext;
}

/**
 * Makes the transport of one server; `headers` gives the headers its class adds per HTTP request
 * (`getHeaders`).
 */
export type TransportFactory = (
  name: string,
  server: ResolvedMcpServer,
  headers: () => Promise<Record<string, string>>,
  /** The `X-AGBoss-Mesh` header of one HTTP request (#1320); `undefined` → none (not a mesh server, no key). */
  meshHeader?: (request: OutboundHttpRequest) => string | undefined,
) => Transport;

export interface McpConnections {
  readonly close: () => Promise<void>;
}

interface ListedTool {
  readonly name: string;
  readonly inputSchema: unknown;
  readonly outputSchema?: unknown;
}

/**
 * stdio: a process with the resolved env; http: the declared headers under the class's
 * `getHeaders()`, read on every request.
 */
export const defaultTransport: TransportFactory = (_name, server, headers, meshHeader) => {
  if (server.transport === McpTransport.Stdio) {
    return new StdioClientTransport({
      command: server.command,
      args: [...server.args],
      env: { ...server.env },
    });
  }
  const withHeaders: typeof fetch = async (input, init) => {
    const own = new Headers(init?.headers);
    const merged = mergedHeaders(server.headers, await headers(), Object.fromEntries(own));
    return signedFetch(fetch, input, init, merged, meshHeader);
  };
  return new StreamableHTTPClientTransport(new URL(server.url), { fetch: withHeaders });
};

/** Where a server's tools differ from the declared ones: our tools' names and the kind of difference, never the server's own words. */
function contractProblems(facades: readonly McpFacade[], listed: readonly ListedTool[]): string[] {
  const byName = new Map(listed.map((tool) => [tool.name, tool]));
  return facades.flatMap((facade) => {
    const remote = byName.get(facade.mcp.tool);
    const where = `${facade.name} (${facade.mcp.server}.${facade.mcp.tool})`;
    if (remote === undefined) return [`${where}: tool not found on the server`];
    const input = schemaDifferences(
      z.toJSONSchema(facade.input, { io: "input" }),
      remote.inputSchema,
    );
    const output =
      remote.outputSchema === undefined
        ? []
        : schemaDifferences(z.toJSONSchema(facade.output), remote.outputSchema);
    return [
      ...(input.length === 0 ? [] : [`${where}: input differs`]),
      ...(output.length === 0 ? [] : [`${where}: output differs`]),
    ];
  });
}

async function openClient(
  transport: Transport,
  identity: McpIdentity,
): Promise<{ client: Client; tools: ListedTool[] }> {
  const client = new Client({ name: identity.name, version: identity.version });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    return { client, tools };
  } catch {
    await client.close().catch(() => undefined);
    // the server's own words are never in the error
    throw new McpError.Unavailable();
  }
}

/**
 * The `_meta` of a call made inside an execution (#398): `callId` — the call's own identity (the
 * step's idempotency key, the server, the tool and the call's key), so an AGBoss server answers a
 * repeated call as the same one and two calls of a step never collide —, the mesh envelope and `traceparent`;
 * none outside one.
 */
function callMetaOf(mesh: OutboundMesh): Record<string, string> {
  return {
    callId: callIdentityOf()?.callId ?? mesh.idempotencyKey,
    [MESH_META_KEY]: mesh.envelope,
    [TRACEPARENT]: mesh.traceparent,
  };
}

/** A result's `_meta`, when it has one. */
const resultMetaOf = (result: unknown): unknown =>
  typeof result === "object" && result !== null ? Reflect.get(result, "_meta") : undefined;

const callerFor =
  (client: Client, audience: string | undefined): McpCaller =>
  async (tool, input, signal) => {
    // the wire takes plain JSON: a validated input is a DTO class instance, which the SDK's record
    // check refuses (what is sent is what the bodyHash binds)
    const args = JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
    // the arguments as sent are what the envelope's bodyHash binds (#398 PR 2), addressed to the
    // server's application when it declares one (PR 3)
    const mesh = outboundMeshOf(JSON.stringify(args), audience);
    const meta = mesh === undefined ? {} : { _meta: callMetaOf(mesh) };
    const result = await client.callTool({ name: tool, arguments: args, ...meta }, undefined, {
      signal,
    });
    const reported = resultMetaOf(result);
    if (mesh !== undefined && typeof reported === "object" && reported !== null)
      takeRunReport("mcp", Reflect.get(reported, MESH_REPORT_META_KEY), mesh.bodyHash);
    return result;
  };

/**
 * Connects every server used by a facade, checks contracts and binds the facades.
 * Any unavailable server or contract difference stops startup (fail fast). `identity` is what the
 * handshake says: the application's name and version.
 */
export async function connectMcpServers(
  servers: Readonly<Record<string, McpServerConfig>> | undefined,
  handles: readonly McpServerHandle<string>[],
  facades: readonly McpFacade[],
  env: Env,
  makeTransport: TransportFactory = defaultTransport,
  identity: McpIdentity = { name: "agboss", version: "0.0.0" },
): Promise<McpConnections> {
  const clients: Client[] = [];
  const closeAll = async (): Promise<void> => {
    handles.forEach((handle) => {
      handle.bind(undefined);
    });
    await Promise.all(clients.map((client) => client.close()));
  };
  try {
    for (const handle of handles) {
      const used = facades.filter((facade) => facade.mcp.server === handle.name);
      if (used.length === 0) continue;
      const config = servers?.[handle.name];
      // a server used by a facade and not declared: nothing to connect to
      if (config === undefined) throw new McpError.Unavailable();
      const resolved = resolvedServerOf(handle.name, config, env);
      const { client, tools } = await openClient(
        makeTransport(handle.name, resolved, handle.headers, (request) =>
          meshHttpHeaderOf(config.target?.application, request, identity.application),
        ),
        identity,
      );
      clients.push(client);
      const problems = contractProblems(used, tools);
      if (problems.length > 0)
        throw new McpError.Contract({ message: `MCP contract drift:\n- ${problems.join("\n- ")}` });
      handle.bind(callerFor(client, config.target?.application));
    }
  } catch (error) {
    await closeAll();
    throw error;
  }
  return { close: closeAll };
}
