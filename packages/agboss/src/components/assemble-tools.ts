import { mcpServer, type McpFacade } from "../tools/index.js";
import { objectSchemaOf } from "../dto/schema.js";
import { checkToolData } from "./runtime.js";
import type { McpServerClient, ServerTools } from "./mcp-client.js";
import type { Class, Token } from "./injection.js";
import { ComponentError, componentOf, requireComponent } from "./metadata.js";
import type { AgentMeta, WorkflowMeta } from "./meta-types.js";
import type { ToolClasses } from "./assemble-checks.js";
import type { McpServerConfig } from "../config/types.js";
import type { McpServerHandle } from "../tools/index.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";

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
  readonly names: ReadonlyMap<Class, string>;
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
    ...tools.mcp.map((cls) => ({
      cls,
      meta: requireComponent(cls, "mcp-tool", "workflowOf").meta,
    })),
  ].flatMap(({ cls, meta: { maxResultSize } }) =>
    maxResultSize === undefined || isResultSize(maxResultSize)
      ? []
      : [resultSizeViolation(cls.name, "its maxResultSize", maxResultSize)],
  );
  return defaults === undefined || isResultSize(defaults)
    ? own
    : [resultSizeViolation(bundle.name, "defaults.tools.maxResultSize", defaults), ...own];
}

/** The tool classes of the workflow's agents, checked: local `@Tool`s and `@McpTool`s. */
export function toolsOf(bundle: WorkflowMeta, agents: readonly AgentMeta[]): ToolClasses {
  const classes = [...new Set(agents.flatMap((agent) => agent.tools ?? []))];
  for (const cls of classes) {
    const kind = componentOf(cls)?.kind;
    if (kind !== "tool" && kind !== "mcp-tool") {
      throw new ComponentError(
        `@Workflow "${bundle.name}": ${cls.name} in an agent's tools is not a @Tool or @McpTool`,
      );
    }
    checkToolData(cls, kind);
  }
  return {
    local: classes.filter((cls) => componentOf(cls)?.kind === "tool"),
    mcp: classes.filter((cls) => componentOf(cls)?.kind === "mcp-tool"),
  };
}

/** The workflow's MCP servers, their facades and instances; every `@McpTool`'s server listed. */
export function mcpOf(bundle: WorkflowMeta, mcpTools: readonly Class[]): Mcp {
  const servers = (bundle.mcp ?? []).map((cls) => ({
    cls,
    ...requireComponent(cls, "mcp-server", `@Workflow "${bundle.name}"`).meta,
  }));
  const handles = [];
  const serverTools: McpFacade[] = [];
  const instances = new Map<Token, unknown>();
  for (const server of servers) {
    const handle = mcpServer(server.name);
    handles.push(handle);
    const facades = new Map(
      Object.entries(server.tools).map(([tool, schemas]) => [
        tool,
        handle.tool({
          tool,
          description: `${server.name}: ${tool}`,
          input: objectSchemaOf(schemas.input),
          output: objectSchemaOf(schemas.output),
        }),
      ]),
    );
    serverTools.push(...facades.values());
    const instance = new (server.cls as unknown as new () => McpServerClient<ServerTools>)();
    instance.attachServerTools(facades);
    instances.set(server.cls, instance);
  }
  for (const cls of mcpTools) {
    const { meta } = requireComponent(cls, "mcp-tool", `@Workflow "${bundle.name}"`);
    if (!instances.has(meta.server)) {
      throw new ComponentError(
        `@McpTool ${cls.name}: its server ${meta.server.name} is not in @Workflow({ mcp })`,
      );
    }
  }
  return {
    servers,
    handles,
    serverTools,
    instances,
    names: new Map(servers.map((s) => [s.cls, s.name] as const)),
  };
}
