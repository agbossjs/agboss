import { componentOf } from "../../components/metadata.js";
import type { Class } from "../../components/injection.js";
import { RagMode } from "../../rag/types.js";
import { NodeKind } from "../ast.js";
import type { AgentDeclaration } from "../decorators/declaration.js";
import type { ImportTable } from "./imports.js";
import type { AnalysedWorkflow, TypeTable } from "./tables.js";

/**
 * The `AgentTools` table (#679): per agent, the names its model may call — each `@Tool` /
 * `@McpTool` it lists and each tool-mode knowledge base's `search-<rag>-tool` — so a scripted
 * `callTool(…)` / `callTools(…)` turn of another tool does not compile. Each tool and knowledge-base
 * class is branded with its name (`readonly [agbossComponent]?: "order-status-tool"`), what
 * `callTool(Tool, …)` reads.
 */

/** The name a tool, MCP tool or knowledge base class is known by; `undefined` for any other class. */
export function toolComponentNameOf(cls: Class): string | undefined {
  const component = componentOf(cls);
  switch (component?.kind) {
    case "tool":
    case "mcp-tool":
    case "rag":
      return component.meta.name;
    default:
      return undefined;
  }
}

/** The tool names of one agent's options, its classes registered for their brands. */
function toolNamesOf(
  options: Pick<AgentDeclaration["options"], "tools" | "rag">,
  names: ImportTable,
): readonly string[] {
  const tools = (options.tools ?? []).flatMap((cls) => {
    const name = toolComponentNameOf(cls);
    if (name === undefined || names.refIfExported(cls) === undefined) return [];
    return [name];
  });
  const searches = (options.rag ?? []).flatMap(({ use, mode }) => {
    const name = toolComponentNameOf(use);
    if (mode !== RagMode.Tool || name === undefined) return [];
    names.refIfExported(use);
    return [`search-${name}-tool`];
  });
  return [...new Set([...tools, ...searches])].sort();
}

/** Every agent's entry: the union of its tool names, `never` for an agent without tools. */
export function agentToolsTableOf(
  workflows: readonly AnalysedWorkflow[],
  names: ImportTable,
): TypeTable {
  const table = new Map<string, string>();
  for (const { analysis } of workflows)
    for (const node of analysis.graph.nodes.values()) {
      const { declaration } = node;
      if (declaration.kind !== NodeKind.Agent || table.has(node.name)) continue;
      const tools = toolNamesOf(declaration.options, names);
      table.set(
        node.name,
        tools.length === 0 ? "never" : tools.map((n) => JSON.stringify(n)).join(" | "),
      );
    }
  return table;
}
