import { mcpServer, type McpFacade } from "../tools/index.js";
import { z } from "zod";
import { objectSchemaOf } from "../dto/schema.js";
import { checkToolData } from "./runtime.js";
import type { McpServerClient, ServerTools } from "./mcp-client.js";
import type { ComponentOptions } from "./component-options.js";
import type { Class, Token } from "./injection.js";
import { ComponentError, componentOf, requireComponent } from "./metadata.js";
import { depsOf } from "./container/container.js";
import type { ProviderModule } from "./container/registrations.js";
import type { AgentMeta, WorkflowMeta } from "./meta-types.js";
import type { ToolClasses } from "./assemble-checks.js";
import type { AssembledWorkflow } from "../workflow.js";
import type { McpServerConfig } from "../config/mcp-server-config.js";
import type { McpServerHandle } from "../tools/index.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";
import { channelRoleOptionsOf } from "../channels/channel-role.decorator.js";
import { questionRoleOf } from "../channels/discovery.js";

/** One `@McpServer` of the workflow: its class, name, launch config and declared tools. */
export interface McpServerPart {
  readonly cls: Class;
  readonly name: string;
  readonly config: McpServerConfig;
  readonly tools: ServerTools;
}

/** The workflow's MCP servers: handles, facades of their tools, instances (injected), names. */
export interface Mcp {
  readonly servers: readonly McpServerPart[];
  readonly handles: readonly McpServerHandle<string>[];
  readonly serverTools: readonly McpFacade[];
  readonly instances: ReadonlyMap<Token, unknown>;
}

/** A bound on tool results is a whole number of bytes from 1 (`kilobytes(64)`, #336). */
const isResultSize = (bytes: number): boolean => Number.isInteger(bytes) && bytes >= 1;

/** `[tools.max-result-size-invalid]` naming where the bound is set and what it is. */
function resultSizeViolation(owner: string, setting: string, bytes: number): RuleViolation {
  const message =
    `${owner}: ${setting} is ${String(bytes)} bytes, not a whole number of bytes from 1 — ` +
    "maxResultSize: kilobytes(64) lets a model read 64 KB of one tool result";
  return violation("tools.max-result-size-invalid", message, [owner]);
}

/**
 * The bounds on what a model reads of one tool result (#336): the workflow's
 * `defaults.tools.maxResultSize` (over its application's) and each tool's own, all at once.
 */
export function resultSizeViolations(bundle: WorkflowMeta, tools: ToolClasses): RuleViolation[] {
  const defaults = bundle.defaults.tools?.maxResultSize;
  const own = [
    ...tools.local.map((cls) => ({ cls, meta: requireComponent(cls, "tool", "workflowOf").meta })),
  ].flatMap(({ cls, meta: { maxResultSize } }) =>
    maxResultSize === undefined || isResultSize(maxResultSize)
      ? []
      : [resultSizeViolation(cls.name, "its maxResultSize", maxResultSize)],
  );
  return defaults === undefined || isResultSize(defaults)
    ? own
    : [resultSizeViolation(bundle.name, "defaults.tools.maxResultSize", defaults), ...own];
}

/** Why a class in an agent's tools is none of what `tools` takes. */
function notAToolMessage(bundle: WorkflowMeta, cls: Class): string {
  const prefix = `@Workflow "${bundle.name}": ${cls.name} in an agent's tools`;
  if (channelRoleOptionsOf(cls) !== undefined)
    return `[channel.approval-role-as-tool] ${prefix} is an approval role: it approves the tools that name it (@Tool({ channel: ${cls.name} })) — only a question role (ask / answer) is an agent's tool`;
  return `${prefix} is not a @Tool or question role`;
}

/**
 * The tool classes of the workflow's agents, checked: local `@Tool`s and the question
 * roles they ask (#712).
 */
export function toolsOf(bundle: WorkflowMeta, agents: readonly AgentMeta[]): ToolClasses {
  const classes = [...new Set(agents.flatMap((agent) => agent.tools ?? []))];
  const asked = classes.filter((cls) => questionRoleOf(cls) !== undefined);
  for (const cls of classes) {
    if (asked.includes(cls)) continue;
    const kind = componentOf(cls)?.kind;
    if (kind !== "tool") throw new ComponentError({ message: notAToolMessage(bundle, cls) });
    checkToolData(cls);
  }
  return {
    local: classes.filter((cls) => componentOf(cls)?.kind === "tool"),
    asked,
  };
}

/**
 * The `@McpServer` classes reachable from `roots` through their `deps` (and those of what they
 * reach), in the order found: a tool, an action or a service that lists a server in its `deps`
 * is what makes the workflow connect it.
 */
export function mcpServerClassesOf(
  roots: readonly Class[],
  modules: readonly ProviderModule[],
): readonly Class[] {
  const listed = modules.flatMap((module) =>
    module.providers.flatMap((provider) => (typeof provider === "function" ? [provider] : [])),
  );
  const reached = new Set<Class>([...roots, ...listed]);
  for (const cls of reached) {
    for (const dep of depsOf(cls)) {
      if (typeof dep === "function") reached.add(dep);
    }
  }
  return [...reached].filter((cls) => componentOf(cls)?.kind === "mcp-server");
}

/** The workflow's MCP servers, their facades and instances. */
export function mcpOf(servers: readonly Class[], options: ComponentOptions): Mcp {
  const parts = servers.map((cls) => ({
    cls,
    // the declared connection and bounds, a profile's `mcpServers` shelf over them
    ...(options.mcpServerMetaOf(cls) ?? requireComponent(cls, "mcp-server", "workflowOf").meta),
  }));
  const handles = [];
  const serverTools: McpFacade[] = [];
  const instances = new Map<Token, unknown>();
  for (const server of parts) {
    const instance = new (server.cls as new () => McpServerClient<ServerTools>)();
    const handle = mcpServer(server.name, {
      headers: () => instance.headersOfRequest(),
      ...(server.config.timeout === undefined ? {} : { timeout: server.config.timeout }),
    });
    handles.push(handle);
    const facades = new Map(
      Object.entries(server.tools).map(([tool, schemas]) => [
        tool,
        handle.tool({
          tool,
          description: `${server.name}: ${tool}`,
          input: schemas.input === undefined ? z.object({}) : objectSchemaOf(schemas.input),
          output: objectSchemaOf(schemas.output),
        }),
      ]),
    );
    serverTools.push(...facades.values());
    instance.attachServerTools(facades);
    instance.attachServer({
      name: server.name,
      timeout: server.config.timeout,
      costPerCall: server.config.costPerCall,
      maxConcurrentCalls: server.config.maxConcurrentCalls,
    });
    instances.set(server.cls, instance);
  }
  return { servers: parts, handles, serverTools, instances };
}

/** The workflow's MCP servers and the server tools declared on them. */
export const mcpPartsOf = (
  mcp: Mcp,
): Pick<
  AssembledWorkflow,
  "mcpServers" | "serverTools" | "mcpServerConfigs" | "mcpServerClasses"
> => ({
  mcpServers: mcp.handles,
  serverTools: mcp.serverTools,
  mcpServerConfigs: Object.fromEntries(mcp.servers.map((s) => [s.name, s.config])),
  mcpServerClasses: new Map(mcp.servers.map((s) => [s.cls, s.name] as const)),
});
