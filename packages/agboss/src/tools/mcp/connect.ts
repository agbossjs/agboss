import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import type { McpServerConfig } from "../../config/types.js";
import { schemaDifferences } from "./compat.js";
import { McpContractError, McpUnavailableError } from "./errors.js";
import type { McpCaller, McpFacade, McpServerHandle } from "./facade.js";
import { MESH_META_KEY, MESH_REPORT_META_KEY, TRACEPARENT } from "../../mesh/mesh-envelope.js";
import { outboundMeshOf, type OutboundMesh } from "../../mesh/outbound-mesh.js";
import { takeRunReport } from "../../mesh/mesh-report.js";

export type Env = Readonly<Record<string, string | undefined>>;
export type TransportFactory = (name: string, server: McpServerConfig, env: Env) => Transport;

export interface McpConnections {
  readonly close: () => Promise<void>;
}

interface ListedTool {
  readonly name: string;
  readonly inputSchema: unknown;
  readonly outputSchema?: unknown;
}

function requireEnv(server: string, names: readonly string[], env: Env): Record<string, string> {
  const values: Record<string, string> = {};
  for (const name of names) {
    const value = env[name];
    if (value === undefined || value === "") {
      throw new McpUnavailableError(
        `MCP server "${server}" needs env variable ${name}, which is not set`,
      );
    }
    values[name] = value;
  }
  return values;
}

/** stdio: env lists variable names; http: headers map header → env variable name. */
export const defaultTransport: TransportFactory = (name, server, env) => {
  if (server.transport === "stdio") {
    return new StdioClientTransport({
      command: server.command,
      args: server.args ?? [],
      env: requireEnv(name, server.env ?? [], env),
    });
  }
  const headerVars = server.headers ?? {};
  const values = requireEnv(name, Object.values(headerVars), env);
  const headers = Object.fromEntries(
    Object.entries(headerVars).map(([header, variable]) => [header, values[variable] ?? ""]),
  );
  return new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } });
};

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
      ...input.map((p) => `${where} input: ${p}`),
      ...output.map((p) => `${where} output: ${p}`),
    ];
  });
}

async function openClient(
  name: string,
  transport: Transport,
): Promise<{ client: Client; tools: ListedTool[] }> {
  const client = new Client({ name: "langgraph-ts-template", version: "0.1.0" });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    return { client, tools };
  } catch (error) {
    await client.close().catch(() => undefined);
    const reason = error instanceof Error ? error.message : String(error);
    throw new McpUnavailableError(`Cannot connect to MCP server "${name}": ${reason}`);
  }
}

/**
 * The `_meta` of a call made inside an execution (#398): `callId` — the step's idempotency key, so
 * an AGBoss server answers a repeated call as the same one —, the mesh envelope and `traceparent`;
 * none outside one.
 */
function callMetaOf(mesh: OutboundMesh): Record<string, string> {
  return {
    callId: mesh.idempotencyKey,
    [MESH_META_KEY]: mesh.envelope,
    [TRACEPARENT]: mesh.traceparent,
  };
}

/** A result's `_meta`, when it has one. */
const resultMetaOf = (result: unknown): unknown =>
  typeof result === "object" && result !== null ? Reflect.get(result, "_meta") : undefined;

const callerFor =
  (client: Client): McpCaller =>
  async (tool, args, signal) => {
    // the arguments as sent are what the envelope's bodyHash binds (#398 PR 2)
    const mesh = outboundMeshOf(JSON.stringify(args));
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
 * Any unavailable server or contract difference stops startup (fail fast).
 */
export async function connectMcpServers(
  servers: Readonly<Record<string, McpServerConfig>> | undefined,
  handles: readonly McpServerHandle<string>[],
  facades: readonly McpFacade[],
  env: Env,
  makeTransport: TransportFactory = defaultTransport,
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
      if (config === undefined) {
        throw new McpUnavailableError(
          `MCP server "${handle.name}" is used by facades but missing in mcpServers`,
        );
      }
      const { client, tools } = await openClient(
        handle.name,
        makeTransport(handle.name, config, env),
      );
      clients.push(client);
      const problems = contractProblems(used, tools);
      if (problems.length > 0)
        throw new McpContractError(`MCP contract drift:\n- ${problems.join("\n- ")}`);
      handle.bind(callerFor(client));
    }
  } catch (error) {
    await closeAll();
    throw error;
  }
  return { close: closeAll };
}
